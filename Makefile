SHELL := /bin/bash
export GOBIN := $(CURDIR)/bin

.PHONY: build run test e2e lint db-up db-down db-reset migrate-new tidy

build:
	go build -o bin/agentchatd ./cmd/agentchatd
	go build -o bin/agentchat ./cmd/agentchat

run: build db-up
	set -a && source .env && set +a && ./bin/agentchatd

test:
	go test ./...

e2e: build db-up
	./scripts/e2e.sh

lint:
	go vet ./...
	@command -v staticcheck >/dev/null && staticcheck ./... || echo "staticcheck not installed; skipping"

db-up:
	docker compose up -d --wait db

db-down:
	docker compose down

db-reset:
	docker compose down -v && docker compose up -d --wait db

# usage: make migrate-new name=add_foo
migrate-new:
	migrate create -ext sql -dir migrations -seq $(name)

tidy:
	go mod tidy
