import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { SimulationReport } from '../domain/report-builder';
import { buildBrainstormFileName, buildBrainstormMarkdown } from './simulation-report.component';

const sampleReport: SimulationReport = {
  runDate: '2026-06-15',
  totalSkus: 80,
  stagesRun: 19,
  totalIssues: 1,
  sections: [
    {
      stage: 11,
      title: 'Chặng 11 · Dự báo nền',
      totalSkus: 80,
      normalCount: 78,
      issues: [
        {
          severity: 'critical',
          title: 'Mô hình dự báo chưa được khóa',
          skuIds: ['SKU-001', 'SKU-002'],
          description: 'Ngưỡng chính thức chưa được ban hành nên cần người duyệt.',
          docReference: 'Chặng này trả lời cách chọn mô hình dự báo.',
          proposal: 'Ban hành ngưỡng khóa mô hình.',
          details: [
            {
              skuId: 'SKU-001',
              skuName: 'Sản phẩm kiểm thử',
              point: 'Mô hình SES ở trạng thái REVIEW',
              reason: 'Ngưỡng khóa mô hình chưa được ban hành.',
              systemAction: 'Hệ thống không tự khóa mô hình và chuyển sang người duyệt.',
              evidence: 'WAPE=31,2%',
            },
          ],
        },
      ],
    },
  ],
  recommendations: ['Ưu tiên khóa ngưỡng dự báo trước khi phát hành đề xuất đặt hàng.'],
};

describe('xuất báo cáo mô phỏng để trao đổi', () => {
  it('tạo bản văn bản có đủ bối cảnh và nhóm vấn đề đang hiển thị', () => {
    const text = buildBrainstormMarkdown(sampleReport, sampleReport.sections, 'SKU-001');

    expect(text).toContain('Phiên chạy: 2026-06-15');
    expect(text).toContain('Phạm vi báo cáo: chỉ SKU SKU-001');
    expect(text).toContain('Chặng 11 · Dự báo nền');
    expect(text).toContain('Mức độ: Nghiêm trọng');
    expect(text).toContain('SKU mẫu: SKU-001, SKU-002');
    expect(text).toContain('Ban hành ngưỡng khóa mô hình.');
    expect(text).toContain('Điểm bất thường: Mô hình SES ở trạng thái REVIEW');
    expect(text).toContain('Lý do: Ngưỡng khóa mô hình chưa được ban hành.');
    expect(text).toContain('Hệ thống xử lý: Hệ thống không tự khóa mô hình và chuyển sang người duyệt.');
    expect(text).toContain('Liên kết trao đổi dự kiến: https://chatgpt.com/c/6a521e45-6f0c-83ec-824f-47170f8985a7');
  });

  it('tạo tên tệp ổn định theo ngày chạy', () => {
    expect(buildBrainstormFileName('2026-06-15')).toBe('bao-cao-mo-phong-2026-06-15.md');
    expect(buildBrainstormFileName('')).toBe('bao-cao-mo-phong-khong-ro-ngay.md');
  });
});
