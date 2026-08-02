SHELL := /bin/bash
PLAUD := npx tsx packages/cli/bin/plaud.ts

# Override on the command line, e.g. `make archive AUDIO_DIR=/data/audio ARGS="--id abc123"`
AUDIO_DIR ?= $(PWD)/audio
ARGS ?=

# archive/* run OpenAI; unset any shell-exported OPENAI_API_KEY so the key in
# .env (or ~/.plaud/.env) is used instead.
ARCHIVE := env -u OPENAI_API_KEY $(PLAUD) archive --audio-dir $(AUDIO_DIR)

.DEFAULT_GOAL := help
.PHONY: help install test login login-token list archive archive-dry seed rename-audio rename-audio-apply cron

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install npm dependencies
	npm install

test: ## Run the test suite (vitest)
	npm test

login: ## Log in via email OTP (plaud login)
	$(PLAUD) login

login-token: ## Log in by pasting a web token (Google/Apple accounts)
	$(PLAUD) login --token

list: ## List recordings (id + date + title)
	$(PLAUD) list

archive: ## Download + transcribe + summarize new recordings (ARGS=... for --id/--limit/--force)
	$(ARCHIVE) $(ARGS)

archive-dry: ## Preview what archive would process + cost (no spend, no writes)
	$(ARCHIVE) --dry-run $(ARGS)

seed: ## Register already-downloaded audio as "downloaded" (no API calls)
	$(ARCHIVE) --seed-existing

rename-audio: ## Preview renaming audio files to recordingId_date_title (dry run)
	npx tsx rename-audio.mts $(AUDIO_DIR)

rename-audio-apply: ## Apply the audio rename
	npx tsx rename-audio.mts $(AUDIO_DIR) --apply

cron: ## Print a daily crontab line for `make archive`
	@echo "0 7 * * * cd $(PWD) && PATH=\"$$(dirname $$(command -v node)):/usr/bin:/bin\" flock -n /tmp/plaud-archive.lock $(PLAUD) archive --audio-dir $(AUDIO_DIR) >> $$HOME/.plaud/archive.log 2>&1"
