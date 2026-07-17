import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if 'class="demand-structure-card"' in line or 'audit-explorer' in line or 'merged-context-panel' in line:
        print(f'{i}: {line.strip()}')
