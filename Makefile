UUID := todo-list@theblackprism.ch
SRC_DIR := src
BUILD_DIR ?= build
STAGE_DIR := $(BUILD_DIR)/stage
ZIP := $(BUILD_DIR)/$(UUID).shell-extension.zip
DATA_HOME := $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
INSTALL_DIR := $(DATA_HOME)/gnome-shell/extensions/$(UUID)
SOURCES := $(shell find $(SRC_DIR) -type f)
PO_FILES := $(wildcard po/*.po)

.PHONY: all pack install uninstall lint test test-gjs smoke pot clean

all: pack

pack: $(ZIP)

$(ZIP): $(SOURCES) $(PO_FILES)
	rm -rf $(STAGE_DIR)
	mkdir -p $(STAGE_DIR)
	cp -r $(SRC_DIR)/. $(STAGE_DIR)/
	for po in $(PO_FILES); do \
		lang=$$(basename $$po .po); \
		mkdir -p $(STAGE_DIR)/locale/$$lang/LC_MESSAGES; \
		msgfmt $$po -o $(STAGE_DIR)/locale/$$lang/LC_MESSAGES/$(UUID).mo; \
	done
	rm -f $(ZIP)
	cd $(STAGE_DIR) && zip -qr $(abspath $(ZIP)) .

install: pack
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	unzip -q $(ZIP) -d $(INSTALL_DIR)
	glib-compile-schemas $(INSTALL_DIR)/schemas
	@echo "Installed to $(INSTALL_DIR). Log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

lint:
	npm run lint

test:
	npm test

test-gjs:
	tests/run-gjs.sh

smoke:
	tests/run-shell-smoke.sh

pot:
	mkdir -p po
	xgettext --from-code=UTF-8 --language=JavaScript --add-comments=Translators \
		--keyword=_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
		--package-name=$(UUID) -o po/$(UUID).pot $$(find $(SRC_DIR) -name '*.js' | sort)

clean:
	rm -rf $(BUILD_DIR)
