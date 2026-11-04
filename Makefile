CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra

ROOT := $(CURDIR)
VERSION := $(shell sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
ifeq ($(strip $(VERSION)),)
VERSION := 1.0.0
endif

CPPFLAGS += -DROUTER_ROOT='"$(ROOT)"' -DROUTER_VERSION='"$(VERSION)"'

PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

all: deepseek-router

transport:
	cd transport && go build -trimpath -ldflags='-s -w' -o deepseek-transport .

deepseek-router: deepseek-router.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $< $(LDFLAGS)

install: deepseek-router
	install -d "$(BINDIR)"
	ln -sfn "$(ROOT)/deepseek-router" "$(BINDIR)/deepseek-router"
	@printf 'installed %s -> %s\n' "$(BINDIR)/deepseek-router" "$(ROOT)/deepseek-router"

uninstall:
	rm -f "$(BINDIR)/deepseek-router"

clean:
	rm -f deepseek-router transport/deepseek-transport

.PHONY: all install uninstall clean transport
