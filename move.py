import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_card = -1
end_card = -1

for i, line in enumerate(lines):
    if '@if (store.view().state && demandStructureChart(); as chart) {' in line:
        start_card = i
    if start_card != -1 and '</section>' in line:
        # The line after is }
        end_card = i + 1
        break

if start_card != -1 and end_card != -1:
    card_lines = lines[start_card:end_card+1]
    del lines[start_card:end_card+1]
    
    # Find insertion point
    # We look for `<div class="panel-head audit-panel-head">`
    # and then the `</div>` that aligns with it.
    insert_idx = -1
    for i, line in enumerate(lines):
        if 'class="panel-head audit-panel-head"' in line:
            # It's at indentation 6 spaces. We look for `      </div>`
            for j in range(i+1, len(lines)):
                if lines[j].startswith('      </div>'):
                    insert_idx = j + 1
                    break
            if insert_idx != -1:
                break
                
    if insert_idx != -1:
        # We might want to wrap the demand-structure-card in a div to separate it from the table
        # or just insert it directly
        lines = lines[:insert_idx] + card_lines + lines[insert_idx:]

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.writelines(lines)
