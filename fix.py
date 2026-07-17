import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 1. Update config popover (lines 10-20 approximately)
for i in range(len(lines)):
    if '<details>' in lines[i] and '⚙️ Cấu hình' in lines[i+1]:
        lines[i] = lines[i].replace('<details>', '<details class="config-popover">')
        lines[i+2] = lines[i+2].replace('<div class="session-controls" aria-label="Tham số phiên mô phỏng" style="margin-top: 10px;">', '<div class="session-controls" aria-label="Tham số phiên mô phỏng">')
        break

# 2. Delete lines 76 to 176 (exception-queue-panel and business-role-panel)
start_del = -1
end_del = -1
for i in range(len(lines)):
    if '@if (exceptionBannerSummary().total > 0) {' in lines[i]:
        start_del = i
    if '@if (currentView() === \'simulation\') {' in lines[i]:
        end_del = i - 1
        break

if start_del != -1 and end_del != -1:
    del lines[start_del:end_del+1]

# 3. Restructure context-column and merged-context-panel
start_context = -1
for i in range(len(lines)):
    if '<details class="merged-context-panel"' in lines[i]:
        start_context = i
        break

if start_context != -1:
    lines.insert(start_context, '<div class="context-column">\n')
    start_context += 1 
    
    start_card = -1
    end_card = -1
    for i in range(start_context, len(lines)):
        if '@if (store.view().state && demandStructureChart(); as chart) {' in lines[i]:
            start_card = i
        if '<div class="context-mode-tabs"' in lines[i]:
            end_card = i - 1
            break
            
    if start_card != -1 and end_card != -1:
        card_lines = lines[start_card:end_card+1]
        del lines[start_card:end_card+1]
        
        for i in range(len(lines)):
            if '<details class="merged-context-panel"' in lines[i]:
                for j, cl in enumerate(card_lines):
                    lines.insert(i + j, cl)
                break
                
    for i in range(start_context, len(lines)):
        if '<section class="panel process-panel collapsible-panel"' in lines[i]:
            lines.insert(i, '</div>\n')
            break

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.writelines(lines)
