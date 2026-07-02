# Contributing to N1nja

🇪🇸 [Versión en español](CONTRIBUTING-ES.md)

Thanks for your interest in contributing! N1nja is an MCP server that detects Hibernate/JPA N+1 queries, slow queries, deadlocks and other anti-patterns in Spring Boot apps. Contributions of all kinds are welcome — bug reports, new detectors, docs, and tests.

## Getting started

```bash
git clone https://github.com/luk-s12/n1nja-mcp.git
cd n1nja-mcp
npm install
npm test
```

Requirements: Node.js >= 18.

## Development workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and write tests for them
4. Ensure all tests pass: `npm test`
5. Ensure no TypeScript errors: `npm run typecheck`
6. Lint your code: `npm run lint`
7. Submit a pull request against `main`

### Useful scripts

| Script | What it does |
| --- | --- |
| `npm test` | Run the Jest test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with a coverage report |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run lint` | Lint `src` and `tests` |
| `npm run build` | Compile to `dist/` |
| `npm run dev` | Run the server from source via `ts-node` |

## Adding a new detector

1. Create `src/core/detection/your-detector.ts` implementing a function that returns `YourIssue[]`
2. Add the issue type to `src/domain/models/issue.model.ts`
3. Register it in `src/core/detection/issue-detector.ts`
4. Write tests in `tests/detector/`

## Coding guidelines

- Match the style and conventions of the surrounding code.
- Every behavioral change should come with tests.
- Keep PRs focused — one logical change per pull request.
- User-facing strings live in `src/shared/i18n/translations.ts`; update both languages.
- README changes must be applied to **both** `README.md` and `README-ES.md`.

## Reporting bugs

Open an issue using the **Bug report** template. Include the input (log snippet or code), what you expected, what happened, and your environment (Node version, OS, database).

## Proposing features

Open an issue using the **Feature request** template and describe the use case before sending a large PR.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).