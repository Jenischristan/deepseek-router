// deepseek-router TUI dashboard (FTXUI).
//
// Polls the router's /health endpoint without any HTTP library: it forks a
// tiny node one-liner that performs the fetch, so the binary stays dependency
// free apart from FTXUI. State lives in shared, mutex-protected snapshots that
// a background thread refreshes while the UI thread only renders.

#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "ftxui/component/component.hpp"
#include "ftxui/component/event.hpp"
#include "ftxui/component/screen_interactive.hpp"
#include "ftxui/dom/elements.hpp"
#include "ftxui/screen/color.hpp"

namespace {

using namespace ftxui;
using Clock = std::chrono::steady_clock;

// -- palette ---------------------------------------------------------------

const Color kBg = Color::RGB(16, 18, 28);
const Color kPanel = Color::RGB(22, 25, 38);
const Color kBorder = Color::RGB(58, 66, 96);
const Color kAccent = Color::RGB(120, 180, 255);
const Color kAccent2 = Color::RGB(180, 140, 255);
const Color kGood = Color::RGB(110, 230, 160);
const Color kWarn = Color::RGB(255, 205, 110);
const Color kBad = Color::RGB(255, 110, 130);
const Color kText = Color::RGB(214, 220, 235);
const Color kMuted = Color::RGB(120, 130, 155);
const Color kFaint = Color::RGB(70, 78, 100);

// -- small helpers ---------------------------------------------------------

std::string trim(std::string s) {
  const char* ws = " \t\r\n";
  const auto first = s.find_first_not_of(ws);
  if (first == std::string::npos) return "";
  const auto last = s.find_last_not_of(ws);
  return s.substr(first, last - first + 1);
}

std::string home_dir() {
  if (const char* h = std::getenv("HOME"); h && *h) return h;
  return "/tmp";
}

std::string config_dir() {
  if (const char* x = std::getenv("XDG_CONFIG_HOME"); x && *x) {
    return std::string(x) + "/deepseek-router";
  }
  return home_dir() + "/.config/deepseek-router";
}

std::string read_file(const std::string& path) {
  std::ifstream f(path);
  if (!f) return "";
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

long read_pid(const std::string& path) {
  const std::string text = trim(read_file(path));
  if (text.empty()) return 0;
  try {
    const long pid = std::stol(text);
    return pid > 0 ? pid : 0;
  } catch (...) {
    return 0;
  }
}

bool pid_alive(long pid) {
  if (pid <= 0) return false;
  return ::kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
}

// -- JSON reading ----------------------------------------------------------

// Extracts a raw JSON value starting at `pos` (after ':'), honouring strings,
// nesting and escapes. Returns the value text and advances `pos` past it.
std::string json_value_at(const std::string& s, size_t& pos) {
  while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos]))) ++pos;
  if (pos >= s.size()) return "";

  const size_t start = pos;
  if (s[pos] == '"') {
    ++pos;
    while (pos < s.size()) {
      if (s[pos] == '\\') {
        pos += 2;
        continue;
      }
      if (s[pos] == '"') {
        ++pos;
        break;
      }
      ++pos;
    }
    return s.substr(start, pos - start);
  }

  if (s[pos] == '{' || s[pos] == '[') {
    const char open = s[pos];
    const char close = open == '{' ? '}' : ']';
    int depth = 0;
    bool in_string = false;
    while (pos < s.size()) {
      const char c = s[pos];
      if (in_string) {
        if (c == '\\') {
          pos += 2;
          continue;
        }
        if (c == '"') in_string = false;
      } else if (c == '"') {
        in_string = true;
      } else if (c == open) {
        ++depth;
      } else if (c == close) {
        --depth;
        if (depth == 0) {
          ++pos;
          break;
        }
      }
      ++pos;
    }
    return s.substr(start, pos - start);
  }

  while (pos < s.size() && s[pos] != ',' && s[pos] != '}' && s[pos] != ']') ++pos;
  return trim(s.substr(start, pos - start));
}

// Finds "key" at any depth and returns its raw value (or "").
std::string json_lookup(const std::string& doc, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = 0;
  while ((pos = doc.find(needle, pos)) != std::string::npos) {
    size_t after = pos + needle.size();
    while (after < doc.size() && std::isspace(static_cast<unsigned char>(doc[after]))) ++after;
    if (after < doc.size() && doc[after] == ':') {
      ++after;
      return json_value_at(doc, after);
    }
    pos = after;
  }
  return "";
}

std::string json_string(const std::string& doc, const std::string& key,
                        const std::string& fallback = "") {
  const std::string raw = json_lookup(doc, key);
  if (raw.size() < 2 || raw.front() != '"' || raw.back() != '"') return fallback;
  std::string out;
  for (size_t i = 1; i + 1 < raw.size(); ++i) {
    if (raw[i] == '\\' && i + 2 < raw.size()) {
      const char next = raw[++i];
      if (next == 'n') out += '\n';
      else if (next == 't') out += '\t';
      else out += next;
    } else {
      out += raw[i];
    }
  }
  return out;
}

double json_number(const std::string& doc, const std::string& key, double fallback = 0) {
  const std::string raw = json_lookup(doc, key);
  if (raw.empty() || raw == "null") return fallback;
  try {
    return std::stod(raw);
  } catch (...) {
    return fallback;
  }
}

bool json_bool(const std::string& doc, const std::string& key, bool fallback = false) {
  const std::string raw = json_lookup(doc, key);
  if (raw == "true") return true;
  if (raw == "false") return false;
  return fallback;
}

std::vector<std::string> json_string_array(const std::string& doc, const std::string& key) {
  std::vector<std::string> out;
  const std::string raw = json_lookup(doc, key);
  if (raw.size() < 2 || raw.front() != '[') return out;
  size_t pos = 1;
  while (pos < raw.size()) {
    const std::string value = json_value_at(raw, pos);
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
      out.push_back(value.substr(1, value.size() - 2));
    }
    while (pos < raw.size() && (raw[pos] == ',' || std::isspace(static_cast<unsigned char>(raw[pos])))) ++pos;
    if (pos < raw.size() && raw[pos] == ']') break;
    if (value.empty()) break;
  }
  return out;
}

// -- HTTP via forked node --------------------------------------------------

const char* kFetchScript =
    "fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t))"
    ".catch(e=>{process.stdout.write('');process.exit(1)});";

std::string fetch_health(const std::string& url, int timeout_ms) {
  int fds[2];
  if (::pipe(fds) != 0) return "";

  const pid_t pid = ::fork();
  if (pid < 0) {
    ::close(fds[0]);
    ::close(fds[1]);
    return "";
  }

  if (pid == 0) {
    ::close(fds[0]);
    ::dup2(fds[1], STDOUT_FILENO);
    ::close(fds[1]);
    ::execlp("node", "node", "-e", kFetchScript, url.c_str(), static_cast<char*>(nullptr));
    ::_exit(127);
  }

  ::close(fds[1]);
  std::string body;
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);

  while (Clock::now() < deadline) {
    fd_set read_set;
    FD_ZERO(&read_set);
    FD_SET(fds[0], &read_set);
    timeval tv{0, 100 * 1000};
    const int ready = ::select(fds[0] + 1, &read_set, nullptr, nullptr, &tv);
    if (ready > 0) {
      std::array<char, 4096> buffer{};
      const ssize_t n = ::read(fds[0], buffer.data(), buffer.size());
      if (n <= 0) break;
      body.append(buffer.data(), static_cast<size_t>(n));
    }
    int status = 0;
    if (::waitpid(pid, &status, WNOHANG) == pid) break;
  }

  ::close(fds[0]);
  int status = 0;
  ::waitpid(pid, &status, WNOHANG);
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0) ::waitpid(pid, &status, 0);
  return trim(body);
}

// -- state -----------------------------------------------------------------

struct LogLine {
  std::string time;
  std::string level;
  std::string text;
};

struct Snapshot {
  bool ok = false;
  std::string error;
  std::string checked_at;
  std::string body;

  bool has_token = false;
  bool has_cookies = false;
  bool has_hif = false;
  int accounts = 0;
  int active_account = 0;
  int switch_after = 0;
  int messages_on_account = 0;
  int sessions = 0;
  bool tool_prompt = false;
  bool tool_parse = false;
  int tool_repair = 0;
  std::vector<std::string> models;

  bool daemon_running = false;
  long daemon_pid = 0;
};

struct DashboardState {
  std::mutex mutex;
  Snapshot state;
  std::vector<LogLine> log;
  std::atomic<bool> quit{false};
  std::atomic<int> refresh_ms{2000};
  std::string base_url = "http://127.0.0.1:8788";
  std::string pid_path;
  std::string log_path;
  int log_lines = 500;
};

std::string now_clock() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
  localtime_r(&t, &tm);
  char buf[16];
  std::strftime(buf, sizeof buf, "%H:%M:%S", &tm);
  return buf;
}

std::vector<LogLine> parse_log(const std::string& text, int limit) {
  std::vector<LogLine> lines;
  std::stringstream ss(text);
  std::string line;
  while (std::getline(ss, line)) {
    if (trim(line).empty()) continue;
    LogLine entry;
    entry.text = line;

    // Router log lines look like: <iso> INFO message
    if (line.size() > 20 && line[4] == '-' && line[10] == 'T') {
      const size_t space = line.find(' ');
      if (space != std::string::npos && space > 11) {
        entry.time = line.substr(11, space - 11);
        const size_t second = line.find(' ', space + 1);
        if (second != std::string::npos) {
          entry.level = line.substr(space + 1, second - space - 1);
          entry.text = line.substr(second + 1);
        } else {
          entry.text = line.substr(space + 1);
        }
      }
    } else if (!line.empty() && line[0] == ' ') {
      entry.time = "";
      entry.level = "INIT";
      entry.text = trim(line);
    } else {
      entry.time = "";
      entry.level = "LOG";
      entry.text = line;
    }

    lines.push_back(std::move(entry));
  }

  if (static_cast<int>(lines.size()) > limit) {
    lines.erase(lines.begin(), lines.end() - limit);
  }
  return lines;
}

void refresh(DashboardState& app) {
  Snapshot snap;
  snap.body = fetch_health(app.base_url + "/health", 1500);
  snap.checked_at = now_clock();

  if (snap.body.empty()) {
    snap.ok = false;
    snap.error = "no response from " + app.base_url;
  } else {
    const std::string upstream = json_lookup(snap.body, "upstream");
    const std::string source = upstream.empty() ? snap.body : upstream;

    snap.ok = json_string(snap.body, "status") == "ok";
    snap.has_token = json_bool(source, "hasToken");
    snap.has_cookies = json_bool(source, "hasCookies");
    snap.has_hif = json_bool(source, "hasHifLeim");
    snap.accounts = static_cast<int>(json_number(source, "accounts"));
    snap.active_account = static_cast<int>(json_number(source, "activeAccount"));
    snap.switch_after = static_cast<int>(json_number(source, "switchAfter"));
    snap.messages_on_account = static_cast<int>(json_number(source, "messagesOnAccount"));
    snap.sessions = static_cast<int>(json_number(snap.body, "sessions"));
    snap.tool_prompt = json_bool(snap.body, "toolPrompt");
    snap.tool_parse = json_bool(snap.body, "toolParse");
    snap.tool_repair = static_cast<int>(json_number(snap.body, "toolRepair"));
    snap.models = json_string_array(snap.body, "models");
    if (!snap.ok) snap.error = "router reported a non-ok status";
  }

  snap.daemon_pid = read_pid(app.pid_path);
  snap.daemon_running = pid_alive(snap.daemon_pid);

  const auto logs = parse_log(read_file(app.log_path), app.log_lines);

  std::lock_guard<std::mutex> lock(app.mutex);
  app.state = std::move(snap);
  app.log = logs;
}

// -- rendering -------------------------------------------------------------

Element dot(bool good) {
  return text("●") | color(good ? kGood : kBad);
}

Element pill(const std::string& label, Color accent) {
  return text(" " + label + " ") | color(kBg) | bgcolor(accent) | bold;
}

Element label(const std::string& text_value) { return text(text_value) | color(kMuted); }

Element value(const std::string& text_value, Color tint = kText) {
  return text(text_value) | color(tint) | bold;
}

Element panel(const std::string& title, Element content) {
  return window(text(" " + title + " ") | color(kAccent) | bold, content | color(kText)) |
         borderStyled(ROUNDED, kBorder) | bgcolor(kPanel);
}

Element header(const Snapshot& snap, const DashboardState& app) {
  const bool healthy = snap.ok;
  const std::string status_text = healthy ? "ONLINE" : "OFFLINE";
  const Color status_color = healthy ? kGood : kBad;

  auto logo = hbox({
      text("◈ ") | color(kAccent2) | bold,
      text("deepseek") | color(kText) | bold,
      text("·") | color(kFaint),
      text("router") | color(kAccent) | bold,
      text("  tui") | color(kMuted),
  });

  auto meta = hbox({
      pill(status_text, status_color),
      text(" "),
      label("upstream ") | dim,
      text(app.base_url) | color(kMuted),
      text("  "),
      label("checked ") | dim,
      text(snap.checked_at.empty() ? "--:--:--" : snap.checked_at) | color(kMuted),
      text("  "),
      label("every ") | dim,
      text(std::to_string(app.refresh_ms.load() / 1000) + "s") | color(kMuted),
  });

  return hbox({logo, filler(), meta}) | bgcolor(kBg);
}

Element account_panel(const Snapshot& snap) {
  const bool has = snap.has_token;
  const int total = std::max(snap.accounts, 0);
  const int active = std::clamp(snap.active_account, 0, std::max(total, 0));

  const float ratio = total > 0 ? static_cast<float>(active) / static_cast<float>(total) : 0.0f;

  Elements rows;
  rows.push_back(hbox({
      label("token     "),
      value(has ? "configured" : "missing", has ? kGood : kBad),
  }));
  rows.push_back(hbox({
      label("account   "),
      value(total > 0 ? std::to_string(active) + " / " + std::to_string(total) : "none",
            total > 0 ? kText : kMuted),
  }));
  rows.push_back(hbox({
      label("rotation  "),
      value(snap.switch_after > 0
                ? std::to_string(snap.messages_on_account) + " / " +
                      std::to_string(snap.switch_after) + " msgs"
                : "sticky",
            snap.switch_after > 0 ? kAccent : kMuted),
  }));

  Elements cookies;
  cookies.push_back(text(snap.has_cookies ? "cookies" : "no cookies") |
                    color(snap.has_cookies ? kGood : kMuted));
  cookies.push_back(text("  ") | color(kFaint));
  cookies.push_back(text(snap.has_hif ? "hif" : "no hif") |
                    color(snap.has_hif ? kGood : kMuted));
  rows.push_back(hbox({label("secrets   "), hbox(std::move(cookies))}));

  rows.push_back(separatorEmpty());
  rows.push_back(hbox({
      label("queue     "),
      gauge(ratio) | color(has ? kAccent : kFaint) | flex,
  }));

  return panel("ACCOUNT", vbox(std::move(rows)));
}

Element runtime_panel(const Snapshot& snap) {
  Elements rows;

  rows.push_back(hbox({
      label("daemon    "),
      dot(snap.daemon_running),
      text(" "),
      value(snap.daemon_running ? "running" : "stopped",
            snap.daemon_running ? kGood : kMuted),
      text(snap.daemon_pid ? "  pid " + std::to_string(snap.daemon_pid) : "") |
          color(kFaint),
  }));

  rows.push_back(hbox({
      label("sessions  "),
      value(std::to_string(snap.sessions), snap.sessions > 0 ? kAccent : kMuted),
      text("  cached upstream") | color(kFaint),
  }));

  rows.push_back(hbox({
      label("tools     "),
      value(snap.tool_prompt ? "prompt on" : "prompt off",
            snap.tool_prompt ? kGood : kWarn),
      text("  "),
      value(snap.tool_parse ? "parse on" : "parse off",
            snap.tool_parse ? kGood : kWarn),
      text("  "),
      value("repair " + std::to_string(snap.tool_repair),
            snap.tool_repair > 0 ? kAccent : kMuted),
  }));

  Elements models;
  if (snap.models.empty()) {
    models.push_back(text("none") | color(kMuted));
  } else {
    for (size_t i = 0; i < snap.models.size(); ++i) {
      if (i) models.push_back(text("  ") | color(kFaint));
      models.push_back(text(snap.models[i]) | color(kAccent2));
    }
  }
  rows.push_back(hbox({label("models    "), hbox(std::move(models))}));

  return panel("RUNTIME", vbox(std::move(rows)));
}

Element timeline_panel(const DashboardState& app, const Snapshot& snap) {
  Elements rows;

  if (!snap.ok && !snap.error.empty()) {
    rows.push_back(hbox({dot(false), text(" "), text(snap.error) | color(kBad)}));
    rows.push_back(text("") );
  }

  std::vector<LogLine> logs;
  {
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(app.mutex));
    logs = app.log;
  }

  if (logs.empty()) {
    rows.push_back(text("no log output yet") | color(kMuted) | dim);
  }

  for (const auto& line : logs) {
    Color level_color = kMuted;
    if (line.level == "ERROR") level_color = kBad;
    else if (line.level == "WARN") level_color = kWarn;
    else if (line.level == "INFO") level_color = kGood;
    else if (line.level == "DEBUG") level_color = kFaint;

    Elements row;
    row.push_back(text(line.time.empty() ? "        " : line.time) | color(kFaint));
    row.push_back(text("  "));
    row.push_back(text((line.level + "      ").substr(0, 6)) | color(level_color) | bold);
    row.push_back(text(" "));
    row.push_back(text(line.text) | color(line.level == "ERROR" ? kBad : kText) | flex);
    rows.push_back(hbox(std::move(row)));
  }

  auto body = vbox(std::move(rows)) | yframe | flex;
  return panel("TIMELINE", body);
}

Element footer(const DashboardState& app) {
  (void)app;
  Elements keys;
  auto key = [](const std::string& k, const std::string& desc) {
    return hbox({
        text(" " + k + " ") | color(kBg) | bgcolor(kBorder) | bold,
        text(" " + desc) | color(kMuted),
    });
  };
  keys.push_back(key("r", "refresh"));
  keys.push_back(text("   "));
  keys.push_back(key("+/-", "interval"));
  keys.push_back(text("   "));
  keys.push_back(key("c", "clear log view"));
  keys.push_back(text("   "));
  keys.push_back(key("q", "quit"));
  return hbox({hbox(std::move(keys)), filler(),
               text("ftxui dashboard") | color(kFaint) | dim}) |
         bgcolor(kBg);
}

Element render(DashboardState& app) {
  Snapshot snap;
  {
    std::lock_guard<std::mutex> lock(app.mutex);
    snap = app.state;
  }

  auto top = hbox({
      account_panel(snap) | flex,
      text(" "),
      runtime_panel(snap) | flex,
  });

  auto body = vbox({
      top,
      text(""),
      timeline_panel(app, snap) | flex,
  }) | flex;

  return vbox({
             header(snap, app),
             separatorLight() | color(kFaint),
             text("") ,
             body,
             text(""),
             footer(app),
         }) |
         bgcolor(kBg) | color(kText);
}

// -- background poller -----------------------------------------------------

void poller(DashboardState& app) {
  while (!app.quit.load()) {
    refresh(app);
    const int step = 50;
    for (int waited = 0; waited < app.refresh_ms.load() && !app.quit.load(); waited += step) {
      std::this_thread::sleep_for(std::chrono::milliseconds(step));
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  DashboardState app;
  app.pid_path = config_dir() + "/router.pid";
  app.log_path = config_dir() + "/router.log";

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if ((arg == "--url" || arg == "-u") && i + 1 < argc) {
      std::string url = argv[++i];
      while (!url.empty() && url.back() == '/') url.pop_back();
      app.base_url = url;
    } else if ((arg == "--port" || arg == "-p") && i + 1 < argc) {
      app.base_url = "http://127.0.0.1:" + std::string(argv[++i]);
    } else if ((arg == "--interval" || arg == "-i") && i + 1 < argc) {
      app.refresh_ms = std::max(500, std::atoi(argv[++i]) * 1000);
    } else if ((arg == "--lines" || arg == "-n") && i + 1 < argc) {
      app.log_lines = std::max(50, std::atoi(argv[++i]));
    } else if (arg == "--help" || arg == "-h") {
      std::printf(
          "deepseek-router TUI dashboard\n\n"
          "Usage: deepseek-router-tui [options]\n\n"
          "  -u, --url URL        router base url (default http://127.0.0.1:8788)\n"
          "  -p, --port PORT      router port (shortcut for --url)\n"
          "  -i, --interval SEC   refresh interval, min 0.5 (default 2)\n"
          "  -n, --lines N        log lines to display (default 500)\n"
          "  -h, --help           show this help\n"
          "\nKeys: r refresh, + / - interval, c clear log view, q quit\n");
      return 0;
    }
  }

  auto screen = ScreenInteractive::Fullscreen();

  // Initial paint before the poller's first round trip completes.
  {
    std::lock_guard<std::mutex> lock(app.mutex);
    app.state.error = "contacting " + app.base_url + " ...";
  }

  std::thread worker(poller, std::ref(app));

  auto component = Renderer([&] { return render(app); });

  component |= CatchEvent([&](Event event) {
    if (event == Event::Character('q') || event == Event::Character('Q') ||
        event == Event::Escape) {
      app.quit = true;
      screen.Exit();
      return true;
    }
    if (event == Event::Character('r') || event == Event::Character('R')) {
      std::thread([&app] { refresh(app); }).detach();
      return true;
    }
    if (event == Event::Character('+') || event == Event::Character('=')) {
      app.refresh_ms = std::min(30000, app.refresh_ms.load() + 1000);
      return true;
    }
    if (event == Event::Character('-') || event == Event::Character('_')) {
      app.refresh_ms = std::max(500, app.refresh_ms.load() - 1000);
      return true;
    }
    if (event == Event::Character('c') || event == Event::Character('C')) {
      std::lock_guard<std::mutex> lock(app.mutex);
      app.log.clear();
      return true;
    }
    return false;
  });

  screen.Loop(component);

  app.quit = true;
  worker.join();
  return 0;
}
