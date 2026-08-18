# Sonar MSBuild Scan Workflow

```mermaid
flowchart TD
    A[sonar_run_scan] --> B{useMsBuild specified?}
    B -->|true| C[MSBuild workflow]
    B -->|false| D[Generic sonar-scanner]
    B -->|omitted| E{solutionFile or .NET files detected?}
    E -->|yes| C
    E -->|no| D

    C --> F[Resolve build target]
    F --> F1[Explicit solutionFile]
    F --> F2[Unique recursive .slnx]
    F --> F3[Unique recursive .sln]
    F --> F4[Unique recursive project]

    F --> G[Sonar begin]
    G --> H[dotnet build target]
    H --> I{Tests enabled?}
    I -->|yes| J[dotnet test same target]
    I -->|no| K[Sonar end]
    J --> K
```

## MSBuild target selection

1. An explicit `solutionFile` is authoritative.
2. Otherwise, a unique recursive `.slnx` is preferred.
3. Otherwise, a unique recursive `.sln` is used.
4. Otherwise, a unique recursive `.csproj` or `.vbproj` is used.
5. The resolved build target is also passed to `dotnet test`.

There is no separate test-directory or test-solution selection. Coverage and TRX reports are collected from tests belonging to the same solution or project used for the scan.
