# Contributing to VulnPen

Firstly, thank you for considering contributing to **VulnPen**! As an open-source project, we thrive on the contributions of community members like you. Whether it's fixing bugs, adding new features, or improving documentation, every contribution is valuable.

## Getting Started

### Prerequisites
Before you begin, ensure you have the following installed:
- **Git**
- **Node.js 22+**
- **pnpm v9+**
- **Docker**

### Setting Up Your Development Environment
Follow the instructions in the [README](./README.md) to set up VulnPen on your local machine.

## How to Contribute

### Reporting Bugs
If you find a bug in the software:
1. Check the [project issue tracker](https://github.com/nerdpremier/vulnpen/issues) to see if it has already been reported.
2. If not, open a new issue and provide a detailed description of the bug, including steps to reproduce it.

### Suggesting Enhancements
We love new ideas! To suggest enhancements:
1. Check if your idea is already being discussed in the [project issue tracker](https://github.com/nerdpremier/vulnpen/issues).
2. If not, open a new issue and label it as a **feature request**.
3. Clearly describe the feature and its benefits.

### Checks That Must Pass

CI runs the same five steps on every push to `main` and every pull request. Run
them before you open one — each block works from inside `backend/` or
`frontend/`, and CI uses Node 22 with pnpm 9.

```bash
pnpm install --frozen-lockfile            # fails if the lockfile is out of step
pnpm run lint
pnpm run build
pnpm test
pnpm audit --prod --audit-level high      # fails on a known high+ prod advisory
```

Commit `pnpm-lock.yaml` with any dependency change or the frozen-lockfile step
fails. A change that passes locally but not in CI is usually a stale lockfile
or a TypeScript error the dev server never hit.

### Pull Requests
1. **Fork the Repository:** Click the 'Fork' button at the top right of the GitHub page to create your own copy of the repository.
2. **Create a Branch:** From your fork, create a branch to work on your contribution. Name it appropriately based on what you're working on (e.g., `feature-add-scanner`, `bugfix-recon-error`).
3. **Make Your Changes:** Implement your changes, adhering to the existing code style and standards.
4. **Test Your Changes:** Ensure your changes don’t break any existing functionality. Add any relevant tests if necessary.
5. **Commit Your Changes:** Use clear and concise commit messages.
6. **Push to Your Branch:** Upload your changes to your fork.
7. **Open a Pull Request:** Go to the original VulnPen repository, and you’ll see a prompt to open a pull request from your new branch. Provide a detailed description of your changes and why they’re necessary.

## License
By contributing to VulnPen, you agree that your contributions will be licensed under its [MIT License](./LICENSE).

