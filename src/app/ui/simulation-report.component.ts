import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { buildSimulationReport, IssueSeverity, ReportIssue, SimulationReport, StageReportSection } from '../domain/report-builder';
import { SimulationStore, viNumberFormat } from '../state/simulation.store';

const SEVERITY_ORDER: Record<IssueSeverity, number> = { critical: 0, warn: 1, info: 2 };
const SEVERITY_LABEL: Record<IssueSeverity, string> = { critical: 'Nghiêm trọng', warn: 'Cần chú ý', info: 'Ghi nhận' };
const SEVERITY_EXPORT_LABEL: Record<IssueSeverity, string> = { critical: 'Nghiêm trọng', warn: 'Cần chú ý', info: 'Ghi nhận' };
const BRAINSTORM_CHAT_URL = 'https://chatgpt.com/c/6a521e45-6f0c-83ec-824f-47170f8985a7';
type ExportStatus = 'idle' | 'copied' | 'downloaded' | 'failed';

@Component({
  selector: 'app-simulation-report',
  standalone: true,
  imports: [],
  templateUrl: './simulation-report.component.html',
  styleUrl: './simulation-report.component.css',
})
export class SimulationReportComponent implements OnDestroy {
  readonly store = inject(SimulationStore);
  readonly severityLabel = SEVERITY_LABEL;
  readonly brainstormUrl = BRAINSTORM_CHAT_URL;
  readonly stageOverrides = signal<Record<number, boolean>>({});
  readonly onlyIssues = signal(true);
  readonly focusedSkuId = signal<string | null>(null);
  readonly detailPreviewLimit = 12;
  readonly exportStatus = signal<ExportStatus>('idle');
  private exportStatusTimer: ReturnType<typeof setTimeout> | null = null;

  readonly report = computed<SimulationReport>(() => buildSimulationReport(
    this.store.snapshots(),
    this.store.completedStage(),
    this.store.policy().runDate,
    this.store.policy().operationalDataStatus,
  ));

  readonly visibleSections = computed(() => {
    const sections = this.report().sections;
    const skuId = this.focusedSkuId();
    const filterOnlyIssues = this.onlyIssues();
    return sections
      .map(section => ({
        ...section,
        issues: section.issues
          .map(item => ({
            ...item,
            skuIds: skuId ? item.skuIds.filter(itemSkuId => itemSkuId === skuId) : item.skuIds,
            details: skuId ? item.details.filter(detail => detail.skuId === skuId) : item.details,
          }))
          .filter(item => item.skuIds.length > 0)
          .slice()
          .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
      }))
      .map(section => {
        if (!skuId) return section;
        return { ...section, normalCount: section.issues.length ? 0 : 1, totalSkus: 1 };
      })
      .filter(section => !filterOnlyIssues || section.issues.length > 0);
  });

  readonly criticalCount = computed(() => this.report().sections.reduce(
    (sum, section) => sum + section.issues.filter(item => item.severity === 'critical').length, 0,
  ));
  readonly warnCount = computed(() => this.report().sections.reduce(
    (sum, section) => sum + section.issues.filter(item => item.severity === 'warn').length, 0,
  ));
  readonly exportText = computed(() => buildBrainstormMarkdown(this.report(), this.visibleSections(), this.focusedSkuId()));
  readonly reportScopeLabel = computed(() => {
    const skuId = this.focusedSkuId();
    if (!skuId) return `Toàn bộ ${this.report().totalSkus} SKU đã chạy`;
    return `${skuId} · ${this.skuName(skuId)}`;
  });
  readonly exportMessage = computed(() => {
    switch (this.exportStatus()) {
      case 'copied': return 'Đã sao chép bản xuất.';
      case 'downloaded': return 'Đã tạo tệp tải về.';
      case 'failed': return 'Chưa xuất được. Hãy thử tải tệp.';
      default: return '';
    }
  });

  ngOnDestroy(): void {
    if (this.exportStatusTimer !== null) clearTimeout(this.exportStatusTimer);
  }

  toggleStage(stage: number): void {
    const current = this.isExpanded(stage);
    this.stageOverrides.update(overrides => ({ ...overrides, [stage]: !current }));
  }
  isExpanded(stage: number): boolean {
    const overrides = this.stageOverrides();
    return Object.prototype.hasOwnProperty.call(overrides, stage) ? overrides[stage] : false;
  }
  setVisibleStagesExpanded(open: boolean): void {
    const visibleStages = this.visibleSections().map(section => section.stage);
    this.stageOverrides.update(overrides => ({
      ...overrides,
      ...Object.fromEntries(visibleStages.map(stage => [stage, open])),
    }));
  }
  focusSku(skuId: string): void {
    this.focusedSkuId.set(this.focusedSkuId() === skuId ? null : skuId);
  }
  skuName(skuId: string): string {
    return this.store.catalog.find(sku => sku.id === skuId)?.name ?? skuId;
  }
  format(value: number): string { return viNumberFormat(0).format(value); }
  issueSkuPreview(issue: ReportIssue, limit = 6): string {
    const shown = issue.skuIds.slice(0, limit).join(', ');
    const rest = issue.skuIds.length - limit;
    return rest > 0 ? `${shown} · +${rest} SKU khác` : shown;
  }
  async copyBrainstormMarkdown(): Promise<void> {
    try {
      const text = this.exportText();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        this.copyWithTextarea(text);
      }
      this.setExportStatus('copied');
    } catch {
      this.setExportStatus('failed');
    }
  }
  downloadBrainstormMarkdown(): void {
    try {
      const blob = new Blob([this.exportText()], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = buildBrainstormFileName(this.report().runDate);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.setExportStatus('downloaded');
    } catch {
      this.setExportStatus('failed');
    }
  }
  private copyWithTextarea(text: string): void {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.inset = '0 auto auto 0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Không thể sao chép báo cáo.');
  }
  private setExportStatus(status: ExportStatus): void {
    this.exportStatus.set(status);
    if (this.exportStatusTimer !== null) clearTimeout(this.exportStatusTimer);
    this.exportStatusTimer = setTimeout(() => this.exportStatus.set('idle'), 3200);
  }
}

export function buildBrainstormMarkdown(
  report: SimulationReport,
  sections: readonly StageReportSection[],
  focusedSkuId: string | null,
): string {
  const lines: string[] = [
    '# Bản xuất báo cáo mô phỏng lập kế hoạch nhu cầu',
    '',
    `- Phiên chạy: ${report.runDate}`,
    `- Số SKU đã chạy: ${report.totalSkus}`,
    `- Số chặng đã khóa: ${report.stagesRun}/19`,
    `- Tổng nhóm vấn đề trong toàn báo cáo: ${report.totalIssues}`,
    `- Phạm vi báo cáo: ${focusedSkuId ? `chỉ SKU ${focusedSkuId}` : `toàn bộ ${report.totalSkus} SKU`}`,
    `- Liên kết trao đổi dự kiến: ${BRAINSTORM_CHAT_URL}`,
    '',
    '## Trọng tâm cần trao đổi',
    '',
    '1. Nguyên nhân gốc nằm ở dữ liệu đầu vào, chính sách, mô hình dự báo, nguồn hàng, hay ngân sách.',
    '2. Vấn đề nào cần chặn vận hành ngay, vấn đề nào chỉ cần theo dõi thêm.',
    '3. Thứ tự xử lý nên đi từ chặng nào trước để tránh sửa ngọn mà bỏ gốc.',
    '',
    '## Các vấn đề đang hiển thị',
    '',
  ];

  if (!sections.length) {
    lines.push('Không có chặng nào khớp với bộ lọc hiện tại.', '');
  }

  for (const section of sections) {
    lines.push(`### ${section.title}`, '');
    lines.push(`- SKU bình thường: ${section.normalCount}/${section.totalSkus}`);
    if (!section.issues.length) {
      lines.push('- Không phát hiện nhóm vấn đề trong chặng này.', '');
      continue;
    }
    lines.push(`- Số nhóm vấn đề: ${section.issues.length}`, '');
    section.issues.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title}`);
      lines.push(`   - Mức độ: ${SEVERITY_EXPORT_LABEL[item.severity]}`);
      lines.push(`   - Số SKU ảnh hưởng: ${item.skuIds.length}`);
      lines.push(`   - SKU mẫu: ${formatSkuPreview(item.skuIds, 30)}`);
      lines.push(`   - Mô tả: ${item.description}`);
      if (item.docReference) lines.push(`   - Căn cứ tài liệu: ${item.docReference}`);
      if (item.proposal) lines.push(`   - Đề xuất hiện tại: ${item.proposal}`);
      if (item.details.length) {
        lines.push('   - Điểm bất thường và xử lý hệ thống:');
        item.details.forEach(detail => {
          lines.push(`     - ${detail.skuId} · ${detail.skuName}`);
          lines.push(`       - Điểm bất thường: ${detail.point}`);
          lines.push(`       - Lý do: ${detail.reason}`);
          lines.push(`       - Hệ thống xử lý: ${detail.systemAction}`);
          if (detail.evidence) lines.push(`       - Bằng chứng: ${detail.evidence}`);
        });
      }
      lines.push('');
    });
  }

  if (report.recommendations.length) {
    lines.push('## Đề xuất tổng hợp của hệ thống', '');
    report.recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push('');
  }

  lines.push('## Bối cảnh đọc báo cáo', '');
  lines.push('Bản xuất này được sinh từ snapshot các chặng đã khóa trong ứng dụng mô phỏng. Mỗi nhóm vấn đề là một dấu hiệu để thảo luận nguyên nhân và hành động tiếp theo, không phải kết luận thay cho người duyệt vận hành.');

  return `${lines.join('\n')}\n`;
}

export function buildBrainstormFileName(runDate: string): string {
  const safeDate = runDate.replace(/[^0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'khong-ro-ngay';
  return `bao-cao-mo-phong-${safeDate}.md`;
}

function formatSkuPreview(skuIds: readonly string[], limit: number): string {
  if (!skuIds.length) return 'không có';
  const shown = skuIds.slice(0, limit).join(', ');
  const rest = skuIds.length - limit;
  return rest > 0 ? `${shown}, và ${rest} SKU khác` : shown;
}
