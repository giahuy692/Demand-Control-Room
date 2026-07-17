import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Remove dataset-meta
start_meta = -1
end_meta = -1
for i in range(len(lines)):
    if '<section class="dataset-meta"' in lines[i]:
        start_meta = i
    if start_meta != -1 and '</section>' in lines[i]:
        end_meta = i
        break

if start_meta != -1 and end_meta != -1:
    del lines[start_meta:end_meta+1]

# Remove legacy buttons
buttons_to_remove = [
    '<button type="button" (click)="comboSalesMode.set(!comboSalesMode())" [class.active]="comboSalesMode()" title="Chế độ Combo & CTKM">Combo: CTKM</button>',
    '<button type="button" class="btn ghost" (click)="journeyOpen.set(true)" title="Sơ đồ hành trình pipeline">⇶ Sơ đồ hành trình</button>',
    '<button type="button" class="btn secondary" (click)="openSimulationReport()">Báo cáo mô phỏng</button>',
    '<button type="button" class="btn secondary" (click)="openComparisonReport()">Báo cáo so sánh</button>'
]

new_lines = []
for line in lines:
    remove = False
    for btn in buttons_to_remove:
        if btn in line:
            remove = True
            break
    if not remove:
        new_lines.append(line)

lines = new_lines

# Fix row properties
for i in range(len(lines)):
    lines[i] = lines[i].replace('row.isStockout', 'row.stockoutStatus !== \'NONE\'')
    lines[i] = lines[i].replace('row.isPromo', 'row.promoCode !== null')

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.writelines(lines)
