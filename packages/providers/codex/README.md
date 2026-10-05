# @umibe/provider-codex

**For local testing only. This package has security issues. Use with caution.**

Connects Umibe to the app-server bundled with the Codex App, providing structured generation for planners and selectors. Uses an existing ChatGPT login without requiring an OpenAI API key.

## Features

- Uses the Codex CLI bundled with the app.
- Uses app-server's default model and reasoning settings, with optional application overrides.
- Disables tools and extensions, allowing only model requests and structured output.
- Handles cancellation, timeouts, errors, and usage reporting.

This package handles communication with app-server. Umibe core owns role instructions, result validation, budgets, and execution.
