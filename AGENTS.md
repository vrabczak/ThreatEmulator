# Coding Instructions

- Always update `SPEC.md` when adding or changing a requirement or feature.
- Always update `README.md` when changing the user interface, installation process, or deployment process.

# Code documentation rules

- Every source file must begin with a short file-level header explaining:
  - the file's purpose,
  - its main responsibilities,
  - important dependencies or assumptions.

- Every class must have a documentation comment describing:
  - its responsibility,
  - how it fits into the application,
  - any important lifecycle or state-management behavior.

- Every public method and function must have a JSDoc/TSDoc header containing:
  - a concise description,
  - @param entries,
  - @returns where applicable,
  - @throws where applicable.

- Add inline comments for:
  - non-obvious algorithms,
  - coordinate transformations,
  - unusual workarounds,
  - performance optimizations,
  - assumptions that cannot be inferred from the code.

- Do not add comments that merely restate the code.

- Preserve and update existing comments whenever implementation changes.
