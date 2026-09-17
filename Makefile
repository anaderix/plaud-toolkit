SHELL := /bin/bash
PLAUD := npx tsx packages/cli/bin/plaud.ts

# Override on the command line, e.g. `make archive AUDIO_DIR=/data/audio ARGS="--id abc123"`
AUDIO_DIR ?= $(PWD)/audio
ARGS ?=

# token-check mails EMAIL_TO (via mutt) when the token has < WARN_DAYS left.
EMAIL_TO ?= andrey.u@gmail.com
WARN_DAYS ?= 3
NODE_PATH_DIR := $(shell dirname $$(command -v node))

# archive/* run OpenAI; unset any shell-exported OPENAI_API_KEY so the key in
# .env (or ~/.plaud/.env) is used instead.
ARCHIVE := env -u OPENAI_API_KEY $(PLAUD) archive --audio-dir $(AUDIO_DIR)

.DEFAULT_GOAL := help
.PHONY: help install test login login-token list archive archive-dry seed rename-audio rename-audio-apply token-status token-check cron

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

token-status: ## Show when the Plaud token expires (checks with the server)
	@$(PLAUD) token-status --verify --warn-days $(WARN_DAYS)

token-check: ## Email EMAIL_TO if the token is expiring (< WARN_DAYS), expired or rejected
	@out=$$($(PLAUD) token-status --verify --warn-days $(WARN_DAYS) 2>&1); rc=$$?; \
	echo "$$(date '+%F %T') rc=$$rc $$out"; \
	if [ $$rc -ne 0 ]; then \
	  printf '%s\n\nRefresh the token:\n  cd $(PWD) && make login\n' "$$out" \
	    | mutt -s "[PLAUD] Token needs refresh $$(date +%F)" -- $(EMAIL_TO) \
	    && echo "$$(date '+%F %T') mailed $(EMAIL_TO)" \
	    || { echo "$$(date '+%F %T') ERROR: mutt send failed"; exit 1; }; \
	fi

cron: ## Print crontab lines: hourly `make archive`, daily 09:00 `make token-check`
	@echo '1 * * * * cd $(PWD) && PATH="$(NODE_PATH_DIR):/usr/bin:/bin" flock -n /tmp/plaud-archive.lock make archive >> $$HOME/.plaud/archive.log 2>&1'
	@echo '0 9 * * * cd $(PWD) && PATH="$(NODE_PATH_DIR):/usr/bin:/bin" make token-check >> $$HOME/.plaud/token-check.log 2>&1'
