# Builds the FTXUI dashboard. FTXUI comes from the system (pkg-config).
CXX ?= g++
CXXFLAGS ?= -O2 -std=c++20 -Wall -Wextra

FTXUI_CFLAGS := $(shell pkg-config --cflags ftxui 2>/dev/null)
FTXUI_LIBS := $(shell pkg-config --libs ftxui 2>/dev/null)
ifeq ($(strip $(FTXUI_LIBS)),)
FTXUI_LIBS := -lftxui-component -lftxui-dom -lftxui-screen
endif

BIN := deepseek-router-tui

all: $(BIN)

$(BIN): dashboard.cpp
	$(CXX) $(CXXFLAGS) $(FTXUI_CFLAGS) -o $@ $< $(FTXUI_LIBS) -pthread

install: $(BIN)
	install -d "$(HOME)/.local/bin"
	install -m 755 $(BIN) "$(HOME)/.local/bin/$(BIN)"

clean:
	rm -f $(BIN)

.PHONY: all install clean
