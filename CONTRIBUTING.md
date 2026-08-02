# Contributing to Coco Terminal

Thanks for helping improve Coco Terminal.

## Development

Requirements:

- Node.js 22 or newer
- npm
- Native build tools required by `node-pty` on your platform

Install dependencies and run the tests:

```bash
npm install --omit=optional
npm test
```

Start the desktop app with `npm start`.

## Pull requests

Keep changes focused, add or update tests when behavior changes, and verify
`npm test` before opening a pull request. Do not commit local environment files,
credentials, private keys, production runbooks, build artifacts, or captured
terminal sessions.

By contributing, you agree that your contributions will be licensed under the
MIT License.
