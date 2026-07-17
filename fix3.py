import sys

with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip = False
for i, line in enumerate(lines):
    if "@if (currentView() === 'simulation') {" in line:
        continue
    if "} @else if (currentView() === 'simulation-report') {" in line:
        skip = True
        continue
    if "@if (journeyOpen()) { <app-journey-map" in line:
        continue
    
    if skip:
        # Check if we reached the closing div of app-shell
        if "</div>" in line and i == len(lines) - 1:
            skip = False
            new_lines.append("</div>\n")
        elif "</div>" in line and i == len(lines) - 2:
            skip = False
            new_lines.append("</div>\n")
        continue

    new_lines.append(line)

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
