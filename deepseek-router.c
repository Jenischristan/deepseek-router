#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef ROUTER_ROOT
#define ROUTER_ROOT ""
#endif

#ifndef ROUTER_VERSION
#define ROUTER_VERSION "1.0.0"
#endif

static int is_file(const char *path) {
  return access(path, R_OK) == 0;
}

static int is_install_root(const char *dir) {
  char path[PATH_MAX];
  if (!dir || !*dir) return 0;
  if (snprintf(path, sizeof path, "%s/src/index.js", dir) >= (int)sizeof path) return 0;
  if (!is_file(path)) return 0;
  if (snprintf(path, sizeof path, "%s/scripts/get-token.py", dir) >= (int)sizeof path) return 0;
  return is_file(path);
}

static int copy_path(char *out, size_t size, const char *path) {
  if (!path || !*path) return 0;
  return snprintf(out, size, "%s", path) < (int)size;
}

static int resolve_root(char *out, size_t size) {
  const char *env = getenv("DEEPSEEK_ROUTER_ROOT");
  if (env && is_install_root(env) && copy_path(out, size, env)) return 1;

  char exe[PATH_MAX];
  ssize_t len = readlink("/proc/self/exe", exe, sizeof exe - 1);
  if (len > 0) {
    exe[len] = '\0';
    char *slash = strrchr(exe, '/');
    if (slash) {
      *slash = '\0';
      if (is_install_root(exe) && copy_path(out, size, exe)) return 1;
    }
  }

  if (is_install_root(ROUTER_ROOT) && copy_path(out, size, ROUTER_ROOT)) return 1;

  char cwd[PATH_MAX];
  if (getcwd(cwd, sizeof cwd)) {
    char dir[PATH_MAX];
    if (copy_path(dir, sizeof dir, cwd)) {
      for (;;) {
        if (is_install_root(dir) && copy_path(out, size, dir)) return 1;
        if (strcmp(dir, "/") == 0) break;
        char *slash = strrchr(dir, '/');
        if (!slash) break;
        if (slash == dir) dir[1] = '\0';
        else *slash = '\0';
      }
    }
  }
  return 0;
}

static int find_program(const char *name, char *out, size_t size) {
  const char *path = getenv("PATH");
  if (!path || !*path) path = "/usr/local/bin:/usr/bin:/bin";

  size_t len = strlen(path);
  char *list = malloc(len + 1);
  if (!list) return 0;
  memcpy(list, path, len + 1);

  int found = 0;
  char *save = NULL;
  for (char *dir = strtok_r(list, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
    char candidate[PATH_MAX];
    if (snprintf(candidate, sizeof candidate, "%s/%s", dir[0] ? dir : ".", name) >= (int)sizeof candidate) continue;
    if (access(candidate, X_OK) == 0) {
      found = copy_path(out, size, candidate);
      break;
    }
  }
  free(list);
  return found;
}

static void run(char *const argv[]) {
  execvp(argv[0], argv);
  fprintf(stderr, "deepseek-router: cannot execute %s: %s\n", argv[0], strerror(errno));
  exit(errno == ENOENT ? 127 : 126);
}

static int run_python(const char *flag, int argc, char **argv, int start) {
  size_t extra = (size_t)(argc > start ? argc - start : 0);
  char **args = calloc(extra + 4, sizeof *args);
  if (!args) {
    perror("deepseek-router: calloc");
    return 1;
  }

  size_t index = 0;
  args[index++] = "python3";
  args[index++] = "scripts/get-token.py";
  if (flag) args[index++] = (char *)flag;
  for (int i = start; i < argc; i++) args[index++] = argv[i];
  args[index] = NULL;
  run(args);
  return 1;
}

static int run_start(int argc, char **argv, int start) {
  for (int i = start; i < argc; i++) {
    if (strcmp(argv[i], "--port") == 0 || strcmp(argv[i], "-p") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "deepseek-router: %s requires a value\n", argv[i - 1]);
        return 2;
      }
      setenv("PORT", argv[i], 1);
    } else if (strcmp(argv[i], "--host") == 0 || strcmp(argv[i], "-H") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "deepseek-router: %s requires a value\n", argv[i - 1]);
        return 2;
      }
      setenv("HOST", argv[i], 1);
    } else if (strcmp(argv[i], "--no-tool-prompt") == 0) {
      setenv("INJECT_TOOL_PROMPT", "0", 1);
    } else if (strcmp(argv[i], "--no-tool-parse") == 0) {
      setenv("PARSE_TOOL_CALLS", "0", 1);
    } else {
      fprintf(stderr, "deepseek-router: unknown start option '%s'\n", argv[i]);
      return 2;
    }
  }

  char *args[] = {"node", "src/index.js", NULL};
  run(args);
  return 1;
}

static int run_test(int argc, char **argv, int start) {
  size_t extra = (size_t)(argc > start ? argc - start : 0);
  char **args = calloc(extra + 3, sizeof *args);
  if (!args) {
    perror("deepseek-router: calloc");
    return 1;
  }

  size_t index = 0;
  args[index++] = "node";
  args[index++] = "--test";
  for (int i = start; i < argc; i++) args[index++] = argv[i];
  args[index] = NULL;
  run(args);
  return 1;
}

static void print_paths(const char *root) {
  char found[PATH_MAX];
  printf("launcher: %s\n", ROUTER_VERSION);
  printf("root:     %s\n", root);
  printf("server:   %s/src/index.js\n", root);
  printf("token:    %s/scripts/get-token.py\n", root);
  printf("node:     %s\n", find_program("node", found, sizeof found) ? found : "(not found)");
  printf("python3:  %s\n", find_program("python3", found, sizeof found) ? found : "(not found)");

  const char *xdg = getenv("XDG_CONFIG_HOME");
  const char *home = getenv("HOME");
  if (xdg && *xdg) printf("config:   %s/deepseek-router/config.json\n", xdg);
  else if (home && *home) printf("config:   %s/.config/deepseek-router/config.json\n", home);
}

static void usage(FILE *out) {
  fprintf(out,
    "deepseek-router %s - compiled launcher for the local DeepSeek router\n"
    "\n"
    "Usage:\n"
    "  deepseek-router [start] [options]    start the OpenAI-compatible server\n"
    "  deepseek-router token [args...]      run the token helper (get-token.py)\n"
    "  deepseek-router token:write          save one browser session to the config\n"
    "  deepseek-router token:accounts       save every token-bearing account\n"
    "  deepseek-router token:watch          add accounts as you switch\n"
    "  deepseek-router test [args...]       run the Node test suite\n"
    "  deepseek-router paths                show resolved paths and tools\n"
    "  deepseek-router --help               show this help\n"
    "  deepseek-router --version            show launcher version\n"
    "\n"
    "Start options:\n"
    "  -p, --port PORT                      listen port (default 8788)\n"
    "  -H, --host HOST                      listen host (default 127.0.0.1)\n"
    "      --no-tool-prompt                 disable DSML prompt injection\n"
    "      --no-tool-parse                  disable DSML tool-call parsing\n"
    "\n"
    "Token examples:\n"
    "  deepseek-router token --list\n"
    "  deepseek-router token --write\n"
    "  deepseek-router token --profile ~/.config/zen/abcd.Default --write\n"
    "  deepseek-router token:watch\n"
    "\n"
    "Environment:\n"
    "  PORT, HOST, DEEPSEEK_ROUTER_ROOT, INJECT_TOOL_PROMPT, PARSE_TOOL_CALLS\n"
    "  DEEPSEEK_ROUTER_KEY, UPSTREAM_MIN_INTERVAL_MS, UPSTREAM_CONCURRENCY\n"
    "\n"
    "Run `deepseek-router token --help` for all token-helper options.\n",
    ROUTER_VERSION);
}

int main(int argc, char **argv) {
  const char *command = argc > 1 ? argv[1] : "start";

  if (strcmp(command, "help") == 0 || strcmp(command, "--help") == 0 || strcmp(command, "-h") == 0) {
    usage(stdout);
    return 0;
  }
  if (strcmp(command, "version") == 0 || strcmp(command, "--version") == 0 || strcmp(command, "-V") == 0) {
    printf("deepseek-router %s\n", ROUTER_VERSION);
    return 0;
  }

  char root[PATH_MAX];
  if (!resolve_root(root, sizeof root)) {
    fprintf(stderr, "deepseek-router: cannot locate the installation (set DEEPSEEK_ROUTER_ROOT)\n");
    return 1;
  }
  if (chdir(root) != 0) {
    fprintf(stderr, "deepseek-router: cannot enter %s: %s\n", root, strerror(errno));
    return 1;
  }

  if (strcmp(command, "paths") == 0) {
    print_paths(root);
    return 0;
  }
  if (strcmp(command, "start") == 0) return run_start(argc, argv, 2);
  if (command[0] == '-') return run_start(argc, argv, 1);
  if (strcmp(command, "token") == 0 || strcmp(command, "get-token") == 0) return run_python(NULL, argc, argv, 2);
  if (strcmp(command, "token:write") == 0) return run_python("--write", argc, argv, 2);
  if (strcmp(command, "token:accounts") == 0) return run_python("--write-accounts", argc, argv, 2);
  if (strcmp(command, "token:watch") == 0) return run_python("--watch", argc, argv, 2);
  if (strcmp(command, "test") == 0) return run_test(argc, argv, 2);

  fprintf(stderr, "deepseek-router: unknown command '%s'\n\n", command);
  usage(stderr);
  return 2;
}
