import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip_view_mode_switch = False

for line in lines:
    if '<div class="view-mode-switch"' in line:
        skip_view_mode_switch = True
        continue
    
    if skip_view_mode_switch:
        if '</div>' in line:
            skip_view_mode_switch = False
        continue

    # Fix errors
    line = line.replace("row.salesObservationStatus === 'ZERO_SALE_INFERRED'", "row.salesObservationStatus === 'CONFIRMED_ZERO'")
    line = line.replace("row.baseDemandSource ?? '—'", "row.baseDemandSource")
    line = line.replace("row.hasRecord ? row.salesObservationStatus : 'KHÔNG CÓ POS'", "row.hasSalesRecord ? row.salesObservationStatus : 'KHÔNG CÓ POS'")
    
    new_lines.append(line)

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
