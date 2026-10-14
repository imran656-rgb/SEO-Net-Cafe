# CafeBot ☕

## Project Purpose
CafeBot is a beginner-friendly AI chatbot designed to assist with cafe management and customer service. It aims to provide a low-cost, minimal implementation for handling customer queries, menu information, and basic orders using an LLM.

## Simple Architecture
- **Frontend**: User interface for interacting with the bot.
- **Backend**: API layer handling requests, LLM orchestration, and data retrieval.
- **Prompts**: Versioned system prompts defining the AI persona and behavior.
- **Data**: Flat-file storage (JSON/CSV) for menus and cafe knowledge.
- **Env**: Environment-specific configuration and secrets.

## Coding Rules
- **Simplicity First**: Prefer readable, straightforward code over complex abstractions.
- **Consistency**: Maintain uniform naming conventions across frontend and backend.
- **Modularity**: Keep prompt logic separate from business logic.
- **Documentation**: Use clear, concise comments for non-obvious logic.

## Security Rules
- **Secrets Management**: Never commit `.env` files; use `.env.example` for templates.
- **Input Validation**: Sanitize all user inputs to prevent injection attacks.
- **Least Privilege**: Use restricted API keys with minimal necessary permissions.

## Token-Saving Rules
- **Concise Prompts**: Keep system prompts lean; avoid redundant instructions.
- **Efficient Context**: Pass only the necessary data (e.g., specific menu items) rather than the entire dataset.
- **Response Constraints**: Instruct the LLM to be brief and direct to minimize output tokens.

## Workflow Instructions
- **Targeted Edits**: Modify only the files strictly necessary for the current task to reduce noise and potential regressions.
