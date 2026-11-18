.PHONY: setup lint format typecheck test check

setup:  ## Install dependencies and the git hooks
	pnpm install
	uvx pre-commit install

lint:
	pnpm lint
	pnpm format:check

format:
	pnpm format

typecheck:
	pnpm typecheck

test:
	pnpm test

check: lint typecheck test
