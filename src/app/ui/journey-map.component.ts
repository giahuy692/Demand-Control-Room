import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, OnDestroy, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import { SimulationStore } from '../state/simulation.store';
import { SkuPipelineState, StageNumber } from '../domain/models';

interface PhaseDef { id: string; code: number; name: string; desc: string; range: string; cssVar: string; stages: number; start: StageNumber; end: StageNumber; }
interface LogEntry { id: number; time: string; html: string; }
interface Tip { h: string; t: string; }

const PHASES: PhaseDef[] = [
  { id: 'p1', code: 1, name: 'Làm sạch dữ liệu & sức mua cơ bản', desc: 'Biến số bán ghi nhận thành chuỗi sức mua cơ bản sạch — không bị kéo thấp bởi stockout, không bị kéo cao bởi CTKM.', range: 'Chặng 1–5', cssVar: '--ph1', stages: 5, start: 1, end: 5 },
  { id: 'p2', code: 2, name: 'Phân loại & gán chính sách', desc: 'Xếp hạng ABC theo giá trị, XYZ/D theo độ đều, rồi gán chính sách vận hành theo ma trận 9 ô.', range: 'Chặng 6–8', cssVar: '--ph2', stages: 3, start: 6, end: 8 },
  { id: 'p3', code: 3, name: 'Cấu trúc nhu cầu, dự báo nền & CTKM', desc: 'Mở đúng mô hình dự báo theo nhóm X/Y/Z/D qua các cửa quyết định, rồi áp hệ số CTKM tương lai.', range: 'Chặng 9–13', cssVar: '--ph3', stages: 5, start: 9, end: 13 },
  { id: 'p4', code: 4, name: 'Nguồn hàng', desc: 'Chuẩn hoá tồn kho, hàng đang về và cam kết để tính vị thế tồn khả dụng thực sự dùng được.', range: 'Chặng 14', cssVar: '--ph4', stages: 1, start: 14, end: 14 },
  { id: 'p5', code: 5, name: 'Dự trữ & số cần mua', desc: 'Tính tồn kho an toàn và số lượng cần đặt trước ngân sách, đúng điều kiện MOQ/quy cách mua.', range: 'Chặng 15–16', cssVar: '--ph5', stages: 2, start: 15, end: 16 },
  { id: 'p6', code: 6, name: 'Ngân sách, phát hành & học lại', desc: 'Phân bổ ngân sách theo ưu tiên, chốt số lượng phát hành, rồi hậu kiểm để đề xuất chỉnh kỳ sau.', range: 'Chặng 17–19', cssVar: '--ph6', stages: 3, start: 17, end: 19 },
];

/** Nhóm nhu cầu (XYZ/D) mà mỗi node phụ thuộc riêng của Chặng 11 chỉ thuộc về — dùng để tô 'skipped' cho các nhánh SKU hiện tại không đi qua. */
const NODE_GROUP: Record<string, 'X' | 'Y' | 'Z' | 'D'> = {
  nD: 'D', nZg: 'Z', nZ2: 'Z', nX1: 'X', nXg: 'X', nX3: 'X', nYhw: 'Y', nYholt: 'Y', nYses: 'Y',
};

const TOOLTIPS: Record<string, Tip> = {
  start: { h: 'Phiên lập kế hoạch', t: 'Khởi động khi đến ngày chạy kế hoạch theo lịch chu kỳ 15 ngày.' },
  n1: { h: 'Chặng 1', t: 'Xác định khoảng ngày lịch sử được phép dùng cho phiên, đủ rộng để nhận diện xu hướng, mùa vụ, độ đều, độ thưa.' },
  n2: { h: 'Chặng 2', t: 'Xác định ngày bán có bị xem là stockout hay không, dựa vào tồn đầu/cuối ngày và giờ nhập hàng đầu tiên.' },
  n3: { h: 'Chặng 3', t: 'Ước lượng mức bán tự nhiên hợp lý thay cho ngày không CTKM bị stockout, dựa vào các ngày sạch xung quanh.' },
  n4: { h: 'Chặng 4', t: 'Đưa số bán ngày CTKM về mức bán tự nhiên trước khi gom chu kỳ, vì CTKM làm số bán cao giả hoặc méo hành vi mua.' },
  n5: { h: 'Chặng 5 · Gate', t: 'Quyết định chu kỳ có thiếu ngày / chưa đủ căn cứ cần lấp nền, hay đã đủ 15 ngày nền.' },
  n5a: { h: 'Chặng 5 · Sub', t: 'Lấp nền cho ngày thiếu hoặc ngày chưa đủ căn cứ trong chu kỳ.' },
  n5b: { h: 'Chặng 5 · Sub', t: 'Chu kỳ đã đủ 15 ngày nền, không cần lấp thêm.' },
  n5c: { h: 'Chặng 5', t: 'Gom sức mua cơ bản cấp ngày thành chu kỳ 15 ngày — đầu ra chuẩn cho toàn bộ các chặng phân loại và dự báo phía sau.' },
  n6: { h: 'Chặng 6', t: 'Phân loại mã hàng theo mức độ quan trọng tài chính (A/B/C) dựa trên giá trị tiêu thụ năm hoá.' },
  n7: { h: 'Chặng 7', t: 'Phân biệt nhu cầu bán đều, dao động, bán thưa hay chưa đủ căn cứ (X/Y/Z/D) để tránh đặt hàng sai cách với mã bán thưa.' },
  n8: { h: 'Chặng 8', t: 'Ghép ABC và XYZ thành ma trận 9 ô để chọn cách quản lý tồn kho, ưu tiên vốn và mức phục vụ đề xuất.' },
  n11r: { h: 'Chặng 11 · Router', t: 'Phân luồng SKU theo nhóm nhu cầu để mở đúng tập ứng viên mô hình dự báo nền — không SKU nào chạy mọi mô hình.' },
  nD: { h: 'Chặng 11 · Sub', t: 'Nhóm D (chưa đủ căn cứ): dùng kế hoạch Thu mua (MD) hoặc mượn mã tương tự.' },
  nZg: { h: 'Gate · Z-PULSE', t: 'Nhóm Z — đo khoảng cách giữa các chu kỳ có nhu cầu > 0; ổn định đủ căn cứ thì mở nhịp phát sinh, không thì xét Croston.' },
  nX1: { h: 'Chặng 11 · Sub', t: 'Nhóm X: thêm SES (san mũ đơn) làm mô hình ứng viên mặc định.' },
  n9: { h: 'Chặng 9 · Gate Y-SEASON', t: 'Chỉ nhóm Y: có vị trí mùa vụ lặp lại đủ căn cứ qua các vòng năm để mở Holt-Winters hay không.' },
  nZ2: { h: 'Chặng 11 · Sub', t: 'Vận hành mô hình nhịp phát sinh nếu Z-PULSE đạt, ngược lại xét Croston cho nhóm Z.' },
  nXg: { h: 'Gate · 11X-TREND', t: 'Nhóm X: 12 chu kỳ gần nhất chia 3 đoạn, hai mức đổi liên tiếp cùng chiều và đạt ngưỡng thì mở Holt.' },
  nYhw: { h: 'Chặng 11 · Sub', t: 'Y-SEASON đạt: vận hành Holt-Winters cho nhóm Y có mùa vụ.' },
  n10: { h: 'Chặng 10 · Gate Y-TREND', t: 'Chỉ nhóm Y không mùa vụ: 12 chu kỳ gần nhất chia 3 đoạn, kiểm tra xu hướng để bật công tắc Holt hoặc SES.' },
  nX3: { h: 'Chặng 11 · Sub', t: '11X-TREND đạt: thêm Holt làm ứng viên cho nhóm X.' },
  nYholt: { h: 'Chặng 11 · Sub', t: 'Y-TREND đạt: vận hành Holt cho nhóm Y không mùa vụ nhưng có xu hướng.' },
  nYses: { h: 'Chặng 11 · Sub', t: 'Y-TREND không đạt: dùng SES hoặc xem là nền ổn định cho nhóm Y.' },
  nSNg: { h: 'Gate · 11XY-SN', t: 'Nhóm X/Y: thử vòng lặp ngắn 2–12 chu kỳ trên tập học; đủ vòng, đủ dữ liệu và đạt ngưỡng giống nhau thì mở Seasonal-naïve.' },
  nSN: { h: 'Chặng 11 · Sub', t: '11XY-SN đạt: thêm Seasonal-naïve vào danh sách ứng viên mô hình.' },
  nBT: { h: 'Chặng 11', t: 'Chọn và kiểm tra ngược toàn bộ ứng viên trên cùng tập kiểm tra, khoá mô hình dự báo nền thắng cho SKU.' },
  n12: { h: 'Chặng 12', t: 'Học hệ số nhân CTKM (sức mua thực tế cao/thấp hơn nền bao nhiêu lần) từ các CTKM lịch sử tương tự.' },
  n13: { h: 'Chặng 13', t: 'Biến dự báo nền thành dự báo cuối bằng cách nhân hệ số CTKM khi có kế hoạch CTKM tương lai đã xác nhận.' },
  n14: { h: 'Chặng 14', t: 'Chuẩn hoá tồn kho, hàng đang về, hàng đã giữ và điều kiện nguồn hàng để xác định tồn khả dụng thực sự dùng được.' },
  n15: { h: 'Chặng 15', t: 'Tính lượng hàng đệm cần giữ thêm để không thiếu hàng khi nhu cầu lệch dự báo hoặc lead time biến động.' },
  n16: { h: 'Chặng 16', t: 'Tính số lượng cần đặt để đủ nhu cầu và đệm an toàn, đúng điều kiện MOQ/quy cách mua, chưa xét ngân sách.' },
  n17: { h: 'Chặng 17', t: 'Khi ngân sách không đủ mua hết đề xuất, xếp dòng đặt hàng vào 3 rổ ưu tiên: mua trước, mua sau, hoặc hoãn.' },
  n18: { h: 'Chặng 18', t: 'Cổng cuối chốt số lượng đặt hàng sau MOQ, cấp tiền và duyệt ngoại lệ — phát hành ngay hoặc chờ duyệt.' },
  n19: { h: 'Chặng 19', t: 'Đo lường quyết định đã phát hành đúng/sai ở khâu nào (nền, mô hình, CTKM, nguồn hàng, tồn an toàn, MOQ, ngân sách) để đề xuất chỉnh kỳ sau.' },
};

const STAGE_TOTAL = 19;

@Component({
  selector: 'app-journey-map',
  standalone: true,
  template: `
    <div class="jm-backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <div class="jm-dialog" role="dialog" aria-modal="true" aria-label="Governance Control Center — 19 chặng xử lý">

      <header class="jm-head">
        <div class="jm-title">
          <span class="jm-glyph" aria-hidden="true">⇶</span>
          <div>
            <p>DEMAND PLANNING &amp; REPLENISHMENT · 19 CHẶNG · 6 PHA · 5 CỬA QUYẾT ĐỊNH</p>
            <h2>Governance Control Center</h2>
          </div>
        </div>
        <div class="jm-tools">
          <div class="jm-progress" title="Tiến độ phiên mô phỏng">
            <div class="jm-ring" [style.--pct]="pct()"></div>
            <span>Tiến độ <b>{{ doneStages() }}/19</b></span>
          </div>
          <button type="button" class="jm-btn" (click)="resetAll()" [disabled]="running()">↺ Reset</button>
          <button type="button" class="jm-btn primary" (click)="runSimulation()" [disabled]="running() || doneStages() >= 19"><span class="jm-dot"></span>Run Simulation</button>
          <button type="button" class="jm-btn close" (click)="closed.emit()" aria-label="Đóng sơ đồ">✕</button>
        </div>
      </header>

      <div class="jm-body">
        <aside class="jm-phases">
          <div class="jm-panel-title">Pha xử lý</div>
          @for (phase of phases; track phase.id) {
            <button type="button" class="jm-phase-card" [class.active]="activePhase() === phase.id"
              [style.--pc]="'var(' + phase.cssVar + ')'" (click)="togglePhase(phase.id)">
              <span class="jm-phase-row">
                <span class="jm-phase-num">P{{ phase.code }}</span>
                <span class="jm-phase-name">{{ phase.name }}</span>
                <span class="jm-phase-count">{{ phaseDone(phase.id) }}/{{ phase.stages }}</span>
              </span>
              <span class="jm-phase-desc">{{ phase.desc }}</span>
              <span class="jm-phase-range">{{ phase.range }}</span>
              <span class="jm-phase-track"><i [style.width.%]="phaseDone(phase.id) / phase.stages * 100"></i></span>
            </button>
          }
          <div class="jm-legend">
            <div class="jm-panel-title" style="padding-bottom:2px;">Trạng thái node</div>
            <div class="jm-legend-row"><span class="jm-lg-swatch pending"></span>Pending — chưa chạy</div>
            <div class="jm-legend-row"><span class="jm-lg-swatch active"></span>Active — đang xử lý</div>
            <div class="jm-legend-row"><span class="jm-lg-swatch done"></span>Completed — hoàn tất</div>
            <div class="jm-legend-row"><span class="jm-lg-swatch skip"></span>Skipped — không áp dụng</div>
            <div class="jm-legend-row"><span class="jm-lg-diamond"></span>Cửa quyết định (gate)</div>
          </div>
        </aside>

        <main class="jm-canvas-wrap" [class.dimmed]="activePhase() !== null">
          <div class="jm-canvas-inner">
            <svg #flowSvg class="jm-flow" viewBox="0 0 1656 3446" role="img" aria-label="Sơ đồ 19 chặng xử lý Demand Planning &amp; Replenishment Governance">
              <defs>
                <marker id="jm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7f8798"/></marker>
                <marker id="jm-arrow-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#555d6e"/></marker>
                <marker id="jm-arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f4d03f"/></marker>
                <marker id="jm-arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffab2e"/></marker>
              </defs>

<path class="edge" data-f="start" data-t="n1" d="M 775,82 C 775,131 775,131 775,180" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n1" data-t="n2" d="M 775,242 C 775,283 775,283 775,324" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n2" data-t="n3" d="M 775,386 C 775,427 775,427 775,468" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n3" data-t="n4" d="M 775,530 C 775,571 775,571 775,612" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n4" data-t="n5" d="M 775,674 C 775,715 775,715 775,756" marker-end="url(#jm-arrow)"/>
<path class="edge yes" data-f="n5" data-t="n5a" d="M 775,856 C 775,878 351,878 351,900" marker-end="url(#jm-arrow)"/>
<text class="elbl yes" x="563.0" y="874.5" text-anchor="middle">Có</text>
<path class="edge no" data-f="n5" data-t="n5b" d="M 775,856 C 775,878 1093,878 1093,900" marker-end="url(#jm-arrow)"/>
<text class="elbl no" x="934.0" y="874.5" text-anchor="middle">Không</text>
<path class="edge" data-f="n5a" data-t="n5c" d="M 351,962 C 351,1003 775,1003 775,1044" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n5b" data-t="n5c" d="M 1093,962 C 1093,1003 775,1003 775,1044" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n5c" data-t="n6" d="M 775,1106 C 775,1147 351,1147 351,1188" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n5c" data-t="n7" d="M 775,1106 C 775,1147 1093,1147 1093,1188" marker-end="url(#jm-arrow)"/>
<path class="edge dep" data-f="n5c" data-t="n11r" d="M 775,1106 C 775,1291 775,1291 775,1476" marker-end="url(#jm-arrow-dep)"/>
<path class="edge dep" data-f="n5c" data-t="n12" d="M 775,1106 C 775,1723 192,1723 192,2340" marker-end="url(#jm-arrow-dep)"/>
<path class="edge" data-f="n6" data-t="n8" d="M 351,1250 C 351,1291 775,1291 775,1332" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n7" data-t="n8" d="M 1093,1250 C 1093,1291 775,1291 775,1332" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n8" data-t="n11r" d="M 775,1394 C 775,1435 775,1435 775,1476" marker-end="url(#jm-arrow)"/>
<path class="edge dep" data-f="n8" data-t="n12" d="M 775,1394 C 775,1867 192,1867 192,2340" marker-end="url(#jm-arrow-dep)"/>
<path class="edge dep" data-f="n8" data-t="n15" d="M 775,1394 C 775,2083 775,2083 775,2772" marker-end="url(#jm-arrow-dep)"/>
<path class="edge dep" data-f="n8" data-t="n17" d="M 775,1394 C 775,2227 775,2227 775,3060" marker-end="url(#jm-arrow-dep)"/>
<path class="edge" data-f="n11r" data-t="nD" d="M 775,1538 C 775,1579 192,1579 192,1620" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n11r" data-t="nZg" d="M 775,1538 C 775,1579 563,1579 563,1620" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n11r" data-t="nX1" d="M 775,1538 C 775,1579 881,1579 881,1620" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n11r" data-t="n9" d="M 775,1538 C 775,1579 1199,1579 1199,1620" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nZg" data-t="nZ2" d="M 563,1720 C 563,1742 563,1742 563,1764" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nX1" data-t="nXg" d="M 881,1682 C 881,1723 881,1723 881,1764" marker-end="url(#jm-arrow)"/>
<path class="edge yes" data-f="nXg" data-t="nX3" d="M 881,1864 C 881,1886 881,1886 881,1908" marker-end="url(#jm-arrow)"/>
<text class="elbl yes" x="881.0" y="1882.5" text-anchor="middle">Có</text>
<path class="edge no" data-f="nXg" data-t="nSNg" d="M 881,1864 C 881,1958 987,1958 987,2052" marker-end="url(#jm-arrow)"/>
<text class="elbl no" x="934.0" y="1943.0" text-anchor="middle">Không</text>
<path class="edge yes" data-f="n9" data-t="nYhw" d="M 1199,1720 C 1199,1742 1146,1742 1146,1764" marker-end="url(#jm-arrow)"/>
<text class="elbl yes" x="1172.5" y="1738.5" text-anchor="middle">Có</text>
<path class="edge no" data-f="n9" data-t="n10" d="M 1199,1720 C 1199,1742 1411,1742 1411,1764" marker-end="url(#jm-arrow)"/>
<text class="elbl no" x="1305.0" y="1738.5" text-anchor="middle">Không</text>
<path class="edge yes" data-f="n10" data-t="nYholt" d="M 1411,1864 C 1411,1886 1305,1886 1305,1908" marker-end="url(#jm-arrow)"/>
<text class="elbl yes" x="1358.0" y="1882.5" text-anchor="middle">Có</text>
<path class="edge no" data-f="n10" data-t="nYses" d="M 1411,1864 C 1411,1886 1517,1886 1517,1908" marker-end="url(#jm-arrow)"/>
<text class="elbl no" x="1464.0" y="1882.5" text-anchor="middle">Không</text>
<path class="edge" data-f="nX3" data-t="nSNg" d="M 881,1970 C 881,2011 987,2011 987,2052" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nYhw" data-t="nSNg" d="M 1146,1826 C 1146,1939 987,1939 987,2052" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nYholt" data-t="nSNg" d="M 1305,1970 C 1305,2011 987,2011 987,2052" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nYses" data-t="nSNg" d="M 1517,1970 C 1517,2011 987,2011 987,2052" marker-end="url(#jm-arrow)"/>
<path class="edge yes" data-f="nSNg" data-t="nSN" d="M 987,2152 C 987,2174 987,2174 987,2196" marker-end="url(#jm-arrow)"/>
<text class="elbl yes" x="987.0" y="2170.5" text-anchor="middle">Có ứng viên</text>
<path class="edge no" data-f="nSNg" data-t="nBT" d="M 987,2152 C 987,2246 828,2246 828,2340" marker-end="url(#jm-arrow)"/>
<text class="elbl no" x="907.5" y="2231.0" text-anchor="middle">Không</text>
<path class="edge" data-f="nSN" data-t="nBT" d="M 987,2258 C 987,2299 828,2299 828,2340" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nD" data-t="nBT" d="M 192,1682 C 192,2011 828,2011 828,2340" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nZ2" data-t="nBT" d="M 563,1826 C 563,2083 828,2083 828,2340" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="nBT" data-t="n13" d="M 828,2402 C 828,2443 775,2443 775,2484" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n12" data-t="n13" d="M 192,2402 C 192,2443 775,2443 775,2484" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n13" data-t="n14" d="M 775,2546 C 775,2587 775,2587 775,2628" marker-end="url(#jm-arrow)"/>
<path class="edge dep" data-f="n13" data-t="n15" d="M 775,2546 C 775,2659 775,2659 775,2772" marker-end="url(#jm-arrow-dep)"/>
<path class="edge" data-f="n14" data-t="n15" d="M 775,2690 C 775,2731 775,2731 775,2772" marker-end="url(#jm-arrow)"/>
<path class="edge dep" data-f="n14" data-t="n16" d="M 775,2690 C 775,2803 775,2803 775,2916" marker-end="url(#jm-arrow-dep)"/>
<path class="edge" data-f="n15" data-t="n16" d="M 775,2834 C 775,2875 775,2875 775,2916" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n16" data-t="n17" d="M 775,2978 C 775,3019 775,3019 775,3060" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n17" data-t="n18" d="M 775,3122 C 775,3163 775,3163 775,3204" marker-end="url(#jm-arrow)"/>
<path class="edge" data-f="n18" data-t="n19" d="M 775,3266 C 775,3307 775,3307 775,3348" marker-end="url(#jm-arrow)"/>
<path class="edge loop" data-f="n19" data-t="n1" d="M 458,3379 L 14,3379 L 14,180 L 458,180" marker-end="url(#jm-arrow-loop)"/>
<text class="elbl loop" x="14.0" y="1764.0" text-anchor="middle">Kỳ sau</text>
<g class="node term" data-id="start" tabindex="0" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="570" y="36" width="410" height="46" rx="23"/>
  <text class="t" x="775.0" y="62.0" text-anchor="middle">Bắt đầu phiên</text>
</g>
<g class="node proc" data-id="n1" data-phase="p1" data-stage="1" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="180" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="191.0" r="4"/>
  <text class="k" x="475.0" y="182.0">CHẶNG 1</text>
  <text class="t" x="475.0" y="200.0">Khoảng lịch sử theo lịch ngày</text>
  <text class="m" x="475.0" y="216.0">khung ngày của phiên</text>
</g>
<g class="node proc" data-id="n2" data-phase="p1" data-stage="2" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="324" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="335.0" r="4"/>
  <text class="k" x="475.0" y="312.0">CHẶNG 2</text>
  <text class="t" x="475.0" y="358.0">Đánh dấu stockout</text>
  <text class="m" x="475.0" y="374.0">tồn đầu · tồn cuối · giờ nhập</text>
</g>
<g class="node proc" data-id="n3" data-phase="p1" data-stage="3" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="468" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="479.0" r="4"/>
  <text class="k" x="475.0" y="484.0">CHẶNG 3</text>
  <text class="t" x="475.0" y="502.0">Sức mua cơ bản (không CTKM)</text>
  <text class="m" x="475.0" y="518.0">ngày stockout, không CTKM</text>
</g>
<g class="node proc" data-id="n4" data-phase="p1" data-stage="4" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="612" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="623.0" r="4"/>
  <text class="k" x="475.0" y="628.0">CHẶNG 4</text>
  <text class="t" x="475.0" y="646.0">Đưa CTKM về mức tự nhiên</text>
  <text class="m" x="475.0" y="662.0">khử méo do khuyến mãi</text>
</g>
<g class="node gate" data-id="n5" data-phase="p1" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 775,756 L 825,806 L 775,856 L 725,806 Z"/>
  <circle class="status-dot" cx="834.0" cy="754.0" r="4"/>
  <text class="t" x="775.0" y="804.0" text-anchor="middle">Cần lấp nền?</text>
  <text class="k" x="775.0" y="817.0" text-anchor="middle">GATE</text>
</g>
<g class="node proc" data-id="n5a" data-phase="p1" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="146" y="900" width="410" height="62" rx="9"/>
  <circle class="status-dot" cx="545.0" cy="911.0" r="4"/>
  <text class="k" x="157.0" y="916.0">SUB-BƯỚC</text>
  <text class="t" x="157.0" y="934.0">5A · Lấp nền</text>
  <text class="m" x="157.0" y="950.0">ngày thiếu / chưa đủ căn cứ</text>
</g>
<g class="node proc" data-id="n5b" data-phase="p1" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="888" y="900" width="410" height="62" rx="9"/>
  <circle class="status-dot" cx="1287.0" cy="911.0" r="4"/>
  <text class="k" x="899.0" y="916.0">SUB-BƯỚC</text>
  <text class="t" x="899.0" y="934.0">5B · Không cần lấp nền</text>
  <text class="m" x="899.0" y="950.0">đã đủ 15 ngày nền</text>
</g>
<g class="node proc" data-id="n5c" data-phase="p1" data-stage="5" tabindex="0" style="--pc:var(--ph1)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="1044" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="1055.0" r="4"/>
  <text class="k" x="475.0" y="1060.0">CHẶNG 5</text>
  <text class="t" x="475.0" y="1078.0">Gộp sức mua theo chu kỳ</text>
  <text class="m" x="475.0" y="1094.0">chuẩn 15 ngày/chu kỳ</text>
</g>
<g class="node proc" data-id="n6" data-phase="p2" data-stage="6" tabindex="0" style="--pc:var(--ph2)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="146" y="1188" width="410" height="62" rx="9"/>
  <circle class="status-dot" cx="545.0" cy="1199.0" r="4"/>
  <text class="k" x="157.0" y="1204.0">CHẶNG 6</text>
  <text class="t" x="157.0" y="1222.0">Phân loại ABC</text>
  <text class="m" x="157.0" y="1238.0">giá trị tiêu thụ năm hoá</text>
</g>
<g class="node proc" data-id="n7" data-phase="p2" data-stage="7" tabindex="0" style="--pc:var(--ph2)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="888" y="1188" width="410" height="62" rx="9"/>
  <circle class="status-dot" cx="1287.0" cy="1199.0" r="4"/>
  <text class="k" x="899.0" y="1204.0">CHẶNG 7</text>
  <text class="t" x="899.0" y="1222.0">Phân loại XYZ/D</text>
  <text class="m" x="899.0" y="1238.0">độ đều · độ thưa</text>
</g>
<g class="node proc" data-id="n8" data-phase="p2" data-stage="8" tabindex="0" style="--pc:var(--ph2)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="1332" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="1343.0" r="4"/>
  <text class="k" x="475.0" y="1348.0">CHẶNG 8</text>
  <text class="t" x="475.0" y="1366.0">Gán chính sách ABC × XYZ</text>
  <text class="m" x="475.0" y="1382.0">ma trận 9 ô</text>
</g>
<g class="node proc" data-id="n11r" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="1476" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="1487.0" r="4"/>
  <text class="k" x="475.0" y="1492.0">SUB-BƯỚC</text>
  <text class="t" x="475.0" y="1510.0">Router theo nhóm X/Y/Z/D</text>
  <text class="m" x="475.0" y="1526.0">mở đúng tập ứng viên</text>
</g>
<g class="node proc" data-id="nD" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="40" y="1620" width="304" height="62" rx="9"/>
  <circle class="status-dot" cx="333.0" cy="1631.0" r="4"/>
  <text class="k" x="51.0" y="1636.0">SUB-BƯỚC</text>
  <text class="t" x="51.0" y="1654.0">11D · MD / mượn mã</text>
  <text class="m" x="51.0" y="1670.0">nhóm D</text>
</g>
<g class="node gate" data-id="nZg" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 563,1620 L 613,1670 L 563,1720 L 513,1670 Z"/>
  <circle class="status-dot" cx="622.0" cy="1618.0" r="4"/>
  <text class="t" x="563.0" y="1668.0" text-anchor="middle">Z-PULSE</text>
  <text class="k" x="563.0" y="1681.0" text-anchor="middle">GATE</text>
</g>
<g class="node proc" data-id="nX1" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="782" y="1620" width="198" height="62" rx="9"/>
  <circle class="status-dot" cx="969.0" cy="1631.0" r="4"/>
  <text class="k" x="793.0" y="1636.0">SUB-BƯỚC</text>
  <text class="t" x="793.0" y="1654.0">11X · + SES</text>
  <text class="m" x="793.0" y="1670.0">nhóm X</text>
</g>
<g class="node gate" data-id="n9" data-phase="p3" data-stage="9" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 1199,1620 L 1249,1670 L 1199,1720 L 1149,1670 Z"/>
  <circle class="status-dot" cx="1258.0" cy="1618.0" r="4"/>
  <text class="t" x="1199.0" y="1668.0" text-anchor="middle">Y-SEASON</text>
  <text class="k" x="1199.0" y="1681.0" text-anchor="middle">CHẶNG 9</text>
</g>
<g class="node proc" data-id="nZ2" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="1764" width="198" height="62" rx="9"/>
  <circle class="status-dot" cx="651.0" cy="1775.0" r="4"/>
  <text class="k" x="475.0" y="1780.0">SUB-BƯỚC</text>
  <text class="t" x="475.0" y="1798.0">11Z · Croston / nhịp</text>
  <text class="m" x="475.0" y="1814.0">phát sinh</text>
</g>
<g class="node gate" data-id="nXg" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 881,1764 L 931,1814 L 881,1864 L 831,1814 Z"/>
  <circle class="status-dot" cx="940.0" cy="1762.0" r="4"/>
  <text class="t" x="881.0" y="1812.0" text-anchor="middle">11X-TREND</text>
  <text class="k" x="881.0" y="1825.0" text-anchor="middle">GATE</text>
</g>
<g class="node proc" data-id="nYhw" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="994" y="1764" width="304" height="62" rx="9"/>
  <circle class="status-dot" cx="1287.0" cy="1775.0" r="4"/>
  <text class="k" x="1005.0" y="1780.0">SUB-BƯỚC</text>
  <text class="t" x="1005.0" y="1798.0">11Y · Holt-Winters</text>
  <text class="m" x="1005.0" y="1814.0">mùa vụ đạt</text>
</g>
<g class="node gate" data-id="n10" data-phase="p3" data-stage="10" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 1411,1764 L 1461,1814 L 1411,1864 L 1361,1814 Z"/>
  <circle class="status-dot" cx="1470.0" cy="1762.0" r="4"/>
  <text class="t" x="1411.0" y="1812.0" text-anchor="middle">Y-TREND</text>
  <text class="k" x="1411.0" y="1825.0" text-anchor="middle">CHẶNG 10</text>
</g>
<g class="node proc" data-id="nX3" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="782" y="1908" width="198" height="62" rx="9"/>
  <circle class="status-dot" cx="969.0" cy="1919.0" r="4"/>
  <text class="k" x="793.0" y="1924.0">SUB-BƯỚC</text>
  <text class="t" x="793.0" y="1942.0">11X · + Holt</text>
  <text class="m" x="793.0" y="1958.0">trend đạt</text>
</g>
<g class="node proc" data-id="nYholt" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="1206" y="1908" width="198" height="62" rx="9"/>
  <circle class="status-dot" cx="1393.0" cy="1919.0" r="4"/>
  <text class="k" x="1217.0" y="1924.0">SUB-BƯỚC</text>
  <text class="t" x="1217.0" y="1942.0">11Y · Holt</text>
  <text class="m" x="1217.0" y="1958.0">trend đạt</text>
</g>
<g class="node proc" data-id="nYses" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="1418" y="1908" width="198" height="62" rx="9"/>
  <circle class="status-dot" cx="1605.0" cy="1919.0" r="4"/>
  <text class="k" x="1429.0" y="1924.0">SUB-BƯỚC</text>
  <text class="t" x="1429.0" y="1942.0">11Y · SES</text>
  <text class="m" x="1429.0" y="1958.0">nền ổn định</text>
</g>
<g class="node gate" data-id="nSNg" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <path class="shape" d="M 987,2052 L 1037,2102 L 987,2152 L 937,2102 Z"/>
  <circle class="status-dot" cx="1046.0" cy="2050.0" r="4"/>
  <text class="t" x="987.0" y="2100.0" text-anchor="middle">11XY-SN</text>
  <text class="k" x="987.0" y="2113.0" text-anchor="middle">GATE</text>
</g>
<g class="node proc" data-id="nSN" data-phase="p3" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="782" y="2196" width="410" height="62" rx="9"/>
  <circle class="status-dot" cx="1181.0" cy="2207.0" r="4"/>
  <text class="k" x="793.0" y="2212.0">SUB-BƯỚC</text>
  <text class="t" x="793.0" y="2230.0">+ Seasonal-naïve</text>
  <text class="m" x="793.0" y="2246.0">ứng viên bổ sung</text>
</g>
<g class="node proc" data-id="nBT" data-phase="p3" data-stage="11" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="358" y="2340" width="940" height="62" rx="9"/>
  <circle class="status-dot" cx="1287.0" cy="2351.0" r="4"/>
  <text class="k" x="369.0" y="2356.0">CHẶNG 11</text>
  <text class="t" x="369.0" y="2374.0">Kiểm tra ngược &amp; khoá mô hình nền</text>
  <text class="m" x="369.0" y="2390.0">backtest toàn bộ ứng viên</text>
</g>
<g class="node proc" data-id="n12" data-phase="p3" data-stage="12" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="40" y="2340" width="304" height="62" rx="9"/>
  <circle class="status-dot" cx="333.0" cy="2351.0" r="4"/>
  <text class="k" x="51.0" y="2356.0">CHẶNG 12</text>
  <text class="t" x="51.0" y="2374.0">Hệ số CTKM lịch sử</text>
  <text class="m" x="51.0" y="2390.0">học từ CTKM quá khứ</text>
</g>
<g class="node proc" data-id="n13" data-phase="p3" data-stage="13" tabindex="0" style="--pc:var(--ph3)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="2484" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="2495.0" r="4"/>
  <text class="k" x="475.0" y="2500.0">CHẶNG 13</text>
  <text class="t" x="475.0" y="2518.0">Áp CTKM tương lai</text>
  <text class="m" x="475.0" y="2534.0">nhân hệ số vào dự báo nền</text>
</g>
<g class="node proc" data-id="n14" data-phase="p4" data-stage="14" tabindex="0" style="--pc:var(--ph4)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="2628" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="2639.0" r="4"/>
  <text class="k" x="475.0" y="2644.0">CHẶNG 14</text>
  <text class="t" x="475.0" y="2662.0">Chuẩn hoá nguồn hàng</text>
  <text class="m" x="475.0" y="2678.0">tồn khả dụng thực sự</text>
</g>
<g class="node proc" data-id="n15" data-phase="p5" data-stage="15" tabindex="0" style="--pc:var(--ph5)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="2772" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="2783.0" r="4"/>
  <text class="k" x="475.0" y="2788.0">CHẶNG 15</text>
  <text class="t" x="475.0" y="2806.0">Tồn kho an toàn</text>
  <text class="m" x="475.0" y="2822.0">đệm theo mức phục vụ</text>
</g>
<g class="node proc" data-id="n16" data-phase="p5" data-stage="16" tabindex="0" style="--pc:var(--ph5)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="2916" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="2927.0" r="4"/>
  <text class="k" x="475.0" y="2932.0">CHẶNG 16</text>
  <text class="t" x="475.0" y="2950.0">Số cần đặt trước ngân sách</text>
  <text class="m" x="475.0" y="2966.0">quy tròn theo MOQ</text>
</g>
<g class="node proc" data-id="n17" data-phase="p6" data-stage="17" tabindex="0" style="--pc:var(--ph6)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="3060" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="3071.0" r="4"/>
  <text class="k" x="475.0" y="3076.0">CHẶNG 17</text>
  <text class="t" x="475.0" y="3094.0">Chọn dòng cấp tiền</text>
  <text class="m" x="475.0" y="3110.0">3 rổ ưu tiên</text>
</g>
<g class="node proc" data-id="n18" data-phase="p6" data-stage="18" tabindex="0" style="--pc:var(--ph6)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="3204" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="3215.0" r="4"/>
  <text class="k" x="475.0" y="3220.0">CHẶNG 18</text>
  <text class="t" x="475.0" y="3238.0">Chốt &amp; phát hành</text>
  <text class="m" x="475.0" y="3254.0">PO hoặc chờ duyệt</text>
</g>
<g class="node proc" data-id="n19" data-phase="p6" data-stage="19" tabindex="0" style="--pc:var(--ph6)" (mouseenter)="onNodeHover($event)" (mousemove)="onNodeMove($event)" (mouseleave)="onNodeLeave()" (focus)="onNodeHover($event)" (blur)="onNodeLeave()">
  <rect class="shape" x="464" y="3348" width="622" height="62" rx="9"/>
  <circle class="status-dot" cx="1075.0" cy="3359.0" r="4"/>
  <text class="k" x="475.0" y="3364.0">CHẶNG 19</text>
  <text class="t" x="475.0" y="3382.0">Hậu kiểm &amp; đề xuất kỳ sau</text>
  <text class="m" x="475.0" y="3398.0">đo lệch, tạo đề xuất</text>
</g>
            </svg>
          </div>
        </main>

        <aside class="jm-metrics">
          <div class="jm-panel-title">Live Metrics · SKU hiện tại</div>
          <div class="jm-sku-card">
            <div class="jm-sku-mark">SKU</div>
            <div>
              <p class="eyebrow">Đang theo dõi</p>
              <p class="code">{{ skuCode() }}</p>
              <p class="name">{{ skuSubtitle() }}</p>
            </div>
          </div>

          <div class="jm-stage-now">
            <div class="jm-spin" [class.on]="running()"></div>
            <div>
              <div class="k">Đang xử lý</div>
              <div class="v">{{ nowLabel() }}</div>
            </div>
          </div>

          <div class="jm-badge-grid">
            <div class="jm-badge abc"><div class="bk">Nhóm ABC</div><div class="bv" [class.set]="abcBadge() !== '—'">{{ abcBadge() }}</div></div>
            <div class="jm-badge xyz"><div class="bk">Nhóm XYZ/D</div><div class="bv" [class.set]="xyzBadge() !== '—'">{{ xyzBadge() }}</div></div>
            <div class="jm-badge clean"><div class="bk">Clean Data</div><div class="bv" [class.set]="cleanBadge() !== 'Chưa xử lý'">{{ cleanBadge() }}</div></div>
            <div class="jm-badge model"><div class="bk">Mô hình dự báo</div><div class="bv" [class.set]="modelBadge() !== '—'">{{ modelBadge() }}</div></div>
          </div>

          <div class="jm-gate-legend">
            <div class="jm-panel-title" style="padding:0 0 2px;">5 cửa quyết định</div>
            <div class="jm-gate-row"><span class="gname">Y-SEASON</span><span class="gdesc">Nhóm Y có mùa vụ lặp lại đủ căn cứ → mở Holt-Winters.</span></div>
            <div class="jm-gate-row"><span class="gname">Y-TREND</span><span class="gdesc">Nhóm Y không mùa vụ, 2 mức đổi cùng chiều đạt ngưỡng → mở Holt.</span></div>
            <div class="jm-gate-row"><span class="gname">11X-TREND</span><span class="gdesc">Nhóm X, 2 mức đổi cùng chiều đạt ngưỡng → mở Holt.</span></div>
            <div class="jm-gate-row"><span class="gname">11XY-SN</span><span class="gdesc">Vòng lặp ngắn 2–12 CK đạt ngưỡng giống nhau → mở Seasonal-naïve.</span></div>
            <div class="jm-gate-row"><span class="gname">Z-PULSE</span><span class="gdesc">Khoảng cách phát sinh nhu cầu ổn định → mở nhịp phát sinh, không thì Croston.</span></div>
          </div>

          <div class="jm-section-h">Nhật ký phiên</div>
          <div class="jm-log">
            @if (log().length === 0) { <div class="jm-log-empty">Chưa có sự kiện.</div> }
            @for (entry of log(); track entry.id) {
              <div class="jm-log-item"><span class="t">{{ entry.time }}</span><span [innerHTML]="entry.html"></span></div>
            }
          </div>
        </aside>
      </div>

      <footer class="jm-foot">Hover vào node để xem mô tả · Chọn pha bên trái để làm nổi bật · Esc để đóng</footer>
    </div>

    <div class="jm-tooltip" [class.show]="tooltipVisible()" [style.left.px]="tooltipX()" [style.top.px]="tooltipY()" [style.--pc]="tooltipPc()">
      <div class="tt-head">{{ tooltipHead() }}</div>
      {{ tooltipText() }}
    </div>
  `,
  styles: `
    :host {
      position: fixed; inset: 0; z-index: 200; display: grid; place-items: center;
      --ph1:#4f8cff; --ph2:#b07bff; --ph3:#ff8a3d; --ph4:#58c774; --ph5:#e6534f; --ph6:#f4d03f;
      font-family: "Aptos", "Segoe UI Variable", sans-serif;
    }
    .jm-backdrop { position: absolute; inset: 0; background: rgba(5,7,11,.8); backdrop-filter: blur(6px); }
    .jm-dialog { position: relative; display: flex; flex-direction: column; width: min(98vw, 1820px); height: 96vh; border: 1px solid #3a404c; border-radius: 12px; overflow: hidden; background: #0c0f15; box-shadow: 0 40px 120px rgba(0,0,0,.55); }

    .jm-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 16px; border-bottom: 1px solid var(--line); background: radial-gradient(circle at 4% 50%, rgba(255,171,46,.1), transparent 26%), var(--panel); }
    .jm-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .jm-glyph { display: grid; place-items: center; flex: 0 0 36px; height: 36px; color: var(--amber); border: 1px solid #63471f; border-radius: 9px; font-size: 18px; }
    .jm-title p { margin: 0; color: var(--muted); font: 700 9px/1.2 "Bahnschrift", sans-serif; letter-spacing: .12em; }
    .jm-title h2 { margin: 4px 0 0; color: var(--text); font: 650 18px "Bahnschrift Condensed", sans-serif; letter-spacing: .02em; }
    .jm-tools { display: flex; align-items: center; gap: 8px; }

    .jm-progress { display: flex; align-items: center; gap: 8px; padding: 5px 12px 5px 5px; border: 1px solid var(--line); border-radius: 99px; background: var(--panel-2); font: 700 11px "Cascadia Code", monospace; color: var(--muted); }
    .jm-progress b { color: var(--text); font-variant-numeric: tabular-nums; }
    .jm-ring { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(var(--amber) calc(var(--pct,0) * 1%), #232838 0); flex: 0 0 auto; }
    .jm-ring::after { content: ""; width: 19px; height: 19px; border-radius: 50%; background: var(--panel-2); }

    .jm-btn { min-height: 32px; padding: 0 13px; border: 1px solid var(--line); border-radius: 7px; background: #151922; color: var(--text); font: 700 12px "Aptos", sans-serif; cursor: pointer; transition: .15s ease; }
    .jm-btn:hover:not(:disabled) { border-color: #50586a; }
    .jm-btn:disabled { opacity: .38; cursor: not-allowed; }
    .jm-btn.primary { display: inline-flex; align-items: center; gap: 8px; color: #15100a; border-color: var(--amber); background: var(--amber); box-shadow: 0 5px 18px rgba(255,171,46,.16); }
    .jm-dot { width: 6px; height: 6px; border-radius: 50%; background: #15100a; opacity: .6; }
    .jm-btn.close { color: #ff9d9d; border-color: #673a40; }

    .jm-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 250px 1fr 292px; }

    .jm-panel-title { font: 700 10px "Bahnschrift", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); padding: 4px 8px 8px; }

    .jm-phases { border-right: 1px solid var(--line); background: #0a0d12; padding: 12px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
    .jm-phase-card { all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; border-radius: 9px; border: 1px solid transparent; background: transparent; transition: background .15s, border-color .15s; }
    .jm-phase-card:hover { background: #141822; }
    .jm-phase-card.active { background: var(--panel-2); border-color: var(--pc); box-shadow: 0 0 0 1px var(--pc) inset; }
    .jm-phase-row { display: flex; align-items: center; gap: 8px; }
    .jm-phase-num { display: grid; place-items: center; width: 22px; height: 22px; flex: 0 0 auto; color: var(--pc); border: 1px solid var(--pc); border-radius: 50%; font: 800 9px "Bahnschrift", sans-serif; background: color-mix(in srgb, var(--pc) 14%, transparent); }
    .jm-phase-name { flex: 1; min-width: 0; font: 650 11.5px "Aptos", sans-serif; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .jm-phase-count { font: 700 10px "Cascadia Code", monospace; color: var(--muted); background: #0009; border: 1px solid var(--line); border-radius: 20px; padding: 1px 7px; font-variant-numeric: tabular-nums; }
    .jm-phase-card.active .jm-phase-count { color: var(--pc); border-color: var(--pc); }
    .jm-phase-desc { padding-left: 30px; color: var(--muted); font-size: 10.5px; line-height: 1.45; }
    .jm-phase-range { padding-left: 30px; color: var(--faint); font: 700 9px "Cascadia Code", monospace; letter-spacing: .03em; }
    .jm-phase-track { margin-left: 30px; height: 3px; border-radius: 99px; background: #0009; overflow: hidden; }
    .jm-phase-track > i { display: block; height: 100%; background: var(--pc); transition: width .4s ease; }
    .jm-legend { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 7px; }
    .jm-legend-row { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--muted); }
    .jm-lg-swatch { width: 16px; height: 11px; border-radius: 3px; flex: 0 0 auto; }
    .jm-lg-swatch.pending { border: 1.5px dashed var(--line); background: transparent; }
    .jm-lg-swatch.active { border: 1.5px solid var(--amber); background: var(--amber-soft); box-shadow: 0 0 6px rgba(255,171,46,.5); }
    .jm-lg-swatch.done { border: 1.5px solid var(--green); background: rgba(123,221,170,.14); }
    .jm-lg-swatch.skip { border: 1.5px dashed var(--faint); background: repeating-linear-gradient(45deg,#161a23,#161a23 3px,#0e1117 3px,#0e1117 6px); }
    .jm-lg-diamond { width: 11px; height: 11px; border: 1.5px solid var(--muted); transform: rotate(45deg); background: transparent; margin: 0 2.5px; }

    .jm-canvas-wrap { position: relative; overflow: auto; background: radial-gradient(rgba(255,255,255,.02) 1px, transparent 1px) 0 0/34px 34px, radial-gradient(circle at 82% 3%, rgba(255,171,46,.05), transparent 26%), #0a0d12; }
    .jm-canvas-inner { padding: 26px 30px 60px; }
    .jm-flow { display: block; width: 100%; height: auto; min-width: 1080px; }
    .jm-flow text { font-family: "Cascadia Code", monospace; pointer-events: none; }
    .jm-flow .k { font-size: 9px; letter-spacing: .06em; fill: var(--pc, var(--faint)); font-weight: 700; }
    .jm-flow .t { font-size: 13.5px; font-weight: 700; fill: var(--text); font-family: "Aptos", sans-serif; }
    .jm-flow .m { font-size: 10px; fill: var(--muted); }

    ::ng-deep .jm-flow .node .shape { fill: var(--panel-2); stroke: var(--line); stroke-width: 1.4; transition: stroke .2s, fill .2s, filter .2s; }
    ::ng-deep .jm-flow .node.term .shape { fill: var(--panel); stroke: var(--line); }
    ::ng-deep .jm-flow .node.term .t { font-family: "Cascadia Code", monospace; font-size: 11px; letter-spacing: .04em; fill: var(--muted); }
    ::ng-deep .jm-flow .node.gate .t { font-family: "Cascadia Code", monospace; font-size: 11.5px; font-weight: 700; }
    ::ng-deep .jm-flow .node.gate .k { fill: var(--faint); }
    ::ng-deep .jm-flow .node { cursor: pointer; }
    ::ng-deep .jm-flow .node .status-dot { fill: var(--faint); transition: fill .2s; }
    ::ng-deep .jm-flow .node[data-status="active"] .shape { stroke: var(--amber); stroke-width: 2; filter: drop-shadow(0 0 8px rgba(255,171,46,.55)); animation: jmPulse 1.3s ease-in-out infinite; }
    ::ng-deep .jm-flow .node[data-status="active"] .status-dot { fill: var(--amber); }
    ::ng-deep .jm-flow .node[data-status="completed"] .shape { stroke: var(--green); stroke-width: 1.8; fill: color-mix(in srgb, var(--green) 8%, var(--panel-2)); }
    ::ng-deep .jm-flow .node[data-status="completed"] .status-dot { fill: var(--green); }
    ::ng-deep .jm-flow .node[data-status="skipped"] .shape { opacity: .4; stroke-dasharray: 4 3; }
    ::ng-deep .jm-flow .node[data-status="skipped"] .t, ::ng-deep .jm-flow .node[data-status="skipped"] .m { opacity: .45; }
    ::ng-deep .jm-flow .node[data-status="skipped"] .status-dot { fill: var(--faint); }
    @keyframes jmPulse { 0%,100% { filter: drop-shadow(0 0 5px rgba(255,171,46,.4)); } 50% { filter: drop-shadow(0 0 14px rgba(255,171,46,.75)); } }
    @media (prefers-reduced-motion: reduce) { ::ng-deep .jm-flow .node[data-status="active"] .shape { animation: none; } }

    ::ng-deep .jm-flow .edge { stroke: var(--faint); stroke-width: 1.5; fill: none; opacity: .55; transition: opacity .25s, stroke .25s; }
    ::ng-deep .jm-flow .edge.dep { stroke-dasharray: 2 4; stroke-width: 1.1; opacity: .32; }
    ::ng-deep .jm-flow .edge.loop { stroke: var(--ph6); stroke-dasharray: 5 4; opacity: .5; }
    ::ng-deep .jm-flow .edge.yes, ::ng-deep .jm-flow .edge.no { opacity: .62; }
    ::ng-deep .jm-flow .elbl { font-family: "Cascadia Code", monospace; font-size: 9.5px; fill: var(--muted); }
    ::ng-deep .jm-flow .elbl.loop { fill: var(--ph6); writing-mode: vertical-rl; }
    ::ng-deep .jm-flow .edge.lit { stroke: var(--amber); opacity: 1; stroke-width: 2; stroke-dasharray: 7 5; animation: jmMarch .9s linear infinite; }
    @keyframes jmMarch { to { stroke-dashoffset: -12; } }
    @media (prefers-reduced-motion: reduce) { ::ng-deep .jm-flow .edge.lit { animation: none; } }
    ::ng-deep .jm-flow .edge.done { stroke: var(--amber); opacity: .85; stroke-width: 1.7; }

    .jm-canvas-wrap.dimmed ::ng-deep .jm-flow .node:not(.hl) { opacity: .15; }
    .jm-canvas-wrap.dimmed ::ng-deep .jm-flow .edge:not(.hl) { opacity: .06; }

    .jm-metrics { border-left: 1px solid var(--line); background: #0a0d12; padding: 12px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 13px; }
    .jm-sku-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; display: grid; grid-template-columns: 38px 1fr; gap: 10px; align-items: center; }
    .jm-sku-mark { display: grid; place-items: center; width: 38px; height: 38px; color: var(--amber); border: 1px solid #5b431f; background: linear-gradient(135deg,#241d13,#14171b); font: 700 13px "Bahnschrift", sans-serif; clip-path: polygon(12% 0,100% 0,100% 88%,88% 100%,0 100%,0 12%); }
    .jm-sku-card .eyebrow { margin: 0; color: var(--faint); font: 700 8.5px "Bahnschrift", sans-serif; letter-spacing: .1em; text-transform: uppercase; }
    .jm-sku-card .code { margin: 3px 0 0; color: var(--amber); font: 700 12px "Cascadia Code", monospace; }
    .jm-sku-card .name { margin: 2px 0 0; font-size: 11px; color: var(--text); line-height: 1.3; }

    .jm-stage-now { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    .jm-spin { width: 22px; height: 22px; border-radius: 50%; flex: 0 0 auto; border: 2px solid #242938; border-top-color: var(--amber); }
    .jm-spin.on { animation: jmSpin 1s linear infinite; }
    @keyframes jmSpin { to { transform: rotate(360deg); } }
    .jm-stage-now .k { font: 700 9px "Bahnschrift", sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
    .jm-stage-now .v { margin-top: 2px; font-size: 11.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .jm-badge-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .jm-badge { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; }
    .jm-badge .bk { font: 700 9px "Bahnschrift", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
    .jm-badge .bv { margin-top: 5px; font: 700 14px "Cascadia Code", monospace; color: var(--faint); font-variant-numeric: tabular-nums; }
    .jm-badge .bv.set { color: var(--text); }
    .jm-badge.abc .bv.set { color: var(--ph2); }
    .jm-badge.xyz .bv.set { color: var(--ph2); }
    .jm-badge.clean .bv.set { color: var(--green); }
    .jm-badge.model .bv.set { color: var(--ph3); }

    .jm-gate-legend { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; display: flex; flex-direction: column; gap: 8px; }
    .jm-gate-row { display: flex; align-items: baseline; gap: 8px; font-size: 10.5px; }
    .jm-gate-row .gname { flex: 0 0 auto; font: 700 10px "Cascadia Code", monospace; color: var(--ph3); }
    .jm-gate-row .gdesc { color: var(--muted); line-height: 1.4; }

    .jm-section-h { font: 700 10px "Bahnschrift", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin: 2px 0 -6px; }
    .jm-log { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
    .jm-log-empty { color: var(--faint); font-size: 11px; padding: 6px 2px; }
    .jm-log-item { border-left: 2px solid var(--line); padding: 1px 0 1px 9px; font-size: 11px; line-height: 1.45; color: var(--muted); }
    .jm-log-item ::ng-deep b { color: var(--text); }
    .jm-log-item .t { display: block; font: 700 8.5px "Cascadia Code", monospace; color: var(--faint); }

    .jm-foot { padding: 7px 16px; border-top: 1px solid var(--line); color: var(--faint); background: #0d1016; font-size: 10px; letter-spacing: .04em; }

    .jm-tooltip { position: fixed; z-index: 260; max-width: 280px; background: #0d1015; border: 1px solid #3a4352; border-radius: 9px; padding: 10px 12px; font-size: 11.5px; line-height: 1.5; color: var(--text); box-shadow: 0 14px 34px rgba(0,0,0,.5); pointer-events: none; opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s; }
    .jm-tooltip.show { opacity: 1; transform: translateY(0); }
    .jm-tooltip .tt-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; font: 700 9.5px "Bahnschrift", sans-serif; letter-spacing: .06em; color: var(--pc, var(--amber)); text-transform: uppercase; }
    .jm-tooltip .tt-head::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--pc, var(--amber)); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JourneyMapComponent implements AfterViewInit, OnDestroy {
  private readonly store = inject(SimulationStore);
  private readonly injector = inject(Injector);

  readonly closed = output<void>();
  readonly phases = PHASES;

  private readonly svgRef = viewChild.required<ElementRef<SVGSVGElement>>('flowSvg');
  private nodeEls: SVGGElement[] = [];
  private edgeEls: SVGPathElement[] = [];
  private byId = new Map<string, SVGGElement>();
  private syncEffect: ReturnType<typeof effect> | null = null;
  private lastLoggedStage = 0;
  private lastLoggedSkuId = '';

  readonly activePhase = signal<string | null>(null);

  // Toàn bộ trạng thái dưới đây đọc trực tiếp từ SimulationStore — cùng một nguồn sự thật
  // với phần còn lại của app, không phải bản mô phỏng riêng của dashboard.
  readonly running = computed(() => this.store.isRunning());
  readonly doneStages = computed(() => this.store.completedStage());
  readonly pct = computed(() => Math.round((this.doneStages() / STAGE_TOTAL) * 100));

  readonly selectedSku = computed(() => this.store.catalog.find(sku => sku.id === this.store.selectedSkuId()) ?? null);
  readonly skuCode = computed(() => this.selectedSku()?.id ?? this.store.selectedSkuId());
  readonly skuName = computed(() => this.selectedSku()?.name ?? 'Chưa chọn SKU');
  readonly skuCategory = computed(() => this.selectedSku()?.category ?? null);
  readonly skuSubtitle = computed(() => {
    const cat = this.skuCategory();
    return cat ? `${this.skuName()} · ${cat}` : this.skuName();
  });

  /** Trạng thái pipeline mới nhất đã tính cho SKU đang chọn — cumulative nên field của các chặng trước không đổi khi chặng sau chạy thêm. */
  readonly latestState = computed<Readonly<SkuPipelineState> | null>(() => {
    const stage = this.store.completedStage();
    if (stage <= 0) return null;
    return this.store.snapshots()[stage as StageNumber]?.states[this.store.selectedSkuId()] ?? null;
  });

  readonly abcBadge = computed(() => (this.doneStages() >= 6 ? this.latestState()?.classification.abc ?? '—' : '—'));
  readonly xyzBadge = computed(() => (this.doneStages() >= 7 ? this.latestState()?.classification.xyz ?? '—' : '—'));
  readonly cleanBadge = computed(() => (this.doneStages() >= 5 ? 'Đã làm sạch' : 'Chưa xử lý'));
  readonly modelBadge = computed(() => (this.doneStages() >= 11 ? this.latestState()?.forecast?.model ?? '—' : '—'));

  readonly nowLabel = computed(() => {
    const cs = this.doneStages();
    const running = this.running();
    const active = this.store.activeStage();
    if (cs >= STAGE_TOTAL) return `Hoàn tất — ${STAGE_TOTAL}/${STAGE_TOTAL} chặng đã xử lý`;
    if (running) return `Đang xử lý Chặng ${Math.min(active, cs + 1)}…`;
    if (cs === 0) return 'Chưa chạy — bấm Run Simulation';
    return `Đã hoàn tất ${cs}/${STAGE_TOTAL} chặng — bấm Run Simulation để tiếp tục`;
  });

  private logSeq = 0;
  readonly log = signal<LogEntry[]>([]);

  readonly tooltipVisible = signal(false);
  readonly tooltipHead = signal('');
  readonly tooltipText = signal('');
  readonly tooltipX = signal(0);
  readonly tooltipY = signal(0);
  readonly tooltipPc = signal('var(--amber)');

  phaseDone(id: string): number {
    const phase = PHASES.find(p => p.id === id);
    if (!phase) return 0;
    return Math.min(Math.max(this.doneStages() - (phase.start - 1), 0), phase.stages);
  }

  ngAfterViewInit(): void {
    const svg = this.svgRef().nativeElement;
    this.nodeEls = Array.from(svg.querySelectorAll<SVGGElement>('.node'));
    this.edgeEls = Array.from(svg.querySelectorAll<SVGPathElement>('.edge'));
    this.nodeEls.forEach(n => this.byId.set(n.dataset['id']!, n));

    this.syncEffect = effect(() => {
      const skuId = this.store.selectedSkuId();
      const state = this.latestState();
      this.syncVisualStatus(state);
      this.syncLog(skuId, this.doneStages(), state);
    }, { injector: this.injector });
  }

  ngOnDestroy(): void {
    this.syncEffect?.destroy();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.closed.emit(); }

  togglePhase(id: string): void {
    this.activePhase.update(cur => (cur === id ? null : id));
    const active = this.activePhase();
    this.nodeEls.forEach(n => n.classList.toggle('hl', n.dataset['phase'] === active));
    this.edgeEls.forEach(e => {
      const f = this.byId.get(e.dataset['f'] ?? '');
      const t = this.byId.get(e.dataset['t'] ?? '');
      const on = (!!f && f.dataset['phase'] === active) || (!!t && t.dataset['phase'] === active);
      e.classList.toggle('hl', on);
    });
    if (active) {
      const first = svgQuery(this.svgRef().nativeElement, `.node[data-phase="${active}"]`);
      first?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  }

  onNodeHover(event: Event): void {
    const el = event.currentTarget as SVGGElement;
    const id = el.dataset['id'];
    if (!id) return;
    const tip = TOOLTIPS[id];
    if (!tip) return;
    const pc = el.style.getPropertyValue('--pc') || 'var(--amber)';
    this.tooltipPc.set(pc);
    this.tooltipHead.set(tip.h);
    this.tooltipText.set(tip.t);
    this.tooltipVisible.set(true);
    this.positionTooltip(el);
  }
  onNodeMove(event: Event): void { this.positionTooltip(event.currentTarget as SVGGElement); }
  onNodeLeave(): void { this.tooltipVisible.set(false); }
  private positionTooltip(el: SVGGElement): void {
    const r = el.getBoundingClientRect();
    this.tooltipX.set(Math.min(window.innerWidth - 300, Math.max(8, r.left)));
    this.tooltipY.set(r.bottom + 10);
  }

  /** Tô trạng thái node/edge theo đúng tiến độ và nhánh XYZ/D thật của SKU đang chọn — không có timeline dựng sẵn. */
  private syncVisualStatus(state: Readonly<SkuPipelineState> | null): void {
    const cs = this.store.completedStage();
    const active = this.store.activeStage();
    const running = this.store.isRunning();

    for (const el of this.nodeEls) {
      const stageAttr = el.dataset['stage'];
      if (!stageAttr) continue;
      const stage = Number(stageAttr);
      el.dataset['status'] = stage <= cs ? 'completed' : running && stage === Math.max(cs + 1, active) ? 'active' : 'pending';
    }

    const subIds = ['n11r', 'nD', 'nZg', 'nZ2', 'nX1', 'nXg', 'nX3', 'nYhw', 'nYholt', 'nYses', 'nSNg', 'nSN'];
    if (cs < 7 || !state) {
      for (const id of subIds) { const el = this.byId.get(id); if (el) el.dataset['status'] = 'pending'; }
    } else {
      const xyz = state.classification.xyz;
      const model = state.forecast?.model ?? null;
      for (const id of subIds) {
        const el = this.byId.get(id);
        if (!el) continue;
        const group = NODE_GROUP[id];
        if (group && group !== xyz) { el.dataset['status'] = 'skipped'; continue; }
        let done: boolean;
        switch (id) {
          case 'n11r': done = true; break;
          case 'nD': case 'nZg': case 'nZ2': case 'nX1': case 'nXg': done = true; break;
          case 'nX3': done = cs >= 11 && model === 'Holt'; break;
          case 'nYhw': done = cs >= 9 && state.seasonality === 'confirmed'; break;
          case 'nYholt': done = cs >= 10 && state.seasonality !== 'confirmed' && (state.trend === 'up' || state.trend === 'down'); break;
          case 'nYses': done = cs >= 10 && state.seasonality !== 'confirmed' && state.trend !== 'up' && state.trend !== 'down'; break;
          case 'nSNg': done = (xyz === 'X' || xyz === 'Y') && cs >= 11; break;
          case 'nSN': done = (xyz === 'X' || xyz === 'Y') && cs >= 11 && model === 'SeasonalNaive'; break;
          default: done = false;
        }
        if (id === 'nSNg' && xyz !== 'X' && xyz !== 'Y') { el.dataset['status'] = 'skipped'; continue; }
        if (id === 'nSN' && xyz !== 'X' && xyz !== 'Y') { el.dataset['status'] = 'skipped'; continue; }
        el.dataset['status'] = done ? 'completed' : cs >= 11 ? 'skipped' : 'pending';
      }
    }

    for (const e of this.edgeEls) {
      const f = this.byId.get(e.dataset['f'] ?? '');
      const t = this.byId.get(e.dataset['t'] ?? '');
      e.classList.toggle('lit', t?.dataset['status'] === 'active');
      e.classList.toggle('done', f?.dataset['status'] === 'completed' && t?.dataset['status'] === 'completed');
    }
  }

  private pushLog(html: string): void {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    this.log.update(cur => [{ id: ++this.logSeq, time, html }, ...cur]);
  }

  /** Ghi nhật ký thật theo tiến độ pipeline; đổi SKU sẽ thuật lại kết quả các chặng đã chạy cho SKU vừa chọn. */
  private syncLog(skuId: string, completedStage: number, state: Readonly<SkuPipelineState> | null): void {
    if (skuId !== this.lastLoggedSkuId) {
      this.lastLoggedSkuId = skuId;
      this.lastLoggedStage = 0;
      const name = this.store.catalog.find(sku => sku.id === skuId)?.name ?? skuId;
      this.pushLog(`<b>Chuyển SKU</b> — đang theo dõi <b>${name}</b>.`);
    }
    if (completedStage < this.lastLoggedStage) { this.lastLoggedStage = completedStage; return; }
    for (let stage = this.lastLoggedStage + 1; stage <= completedStage; stage++) {
      const stageState = this.store.snapshots()[stage as StageNumber]?.states[skuId] ?? state;
      this.logStageEvent(stage, stageState);
    }
    this.lastLoggedStage = completedStage;
  }

  private logStageEvent(stage: number, state: Readonly<SkuPipelineState> | null): void {
    if (!state) { this.pushLog(`<b>Chặng ${stage}</b> — hoàn tất.`); return; }
    switch (stage) {
      case 5: this.pushLog(`<b>Chặng 5</b> — Gộp chu kỳ hoàn tất, ${state.cycles.filter(c => c.locked).length} chu kỳ khoá.`); break;
      case 6: this.pushLog(`<b>Chặng 6</b> — Phân loại ABC: nhóm <b>${state.classification.abc}</b>.`); break;
      case 7: this.pushLog(`<b>Chặng 7</b> — Phân loại XYZ/D: nhóm <b>${state.classification.xyz}</b>.`); break;
      case 8: this.pushLog(`<b>Chặng 8</b> — Chính sách: ${state.serviceLevel ? `mức phục vụ ${state.serviceLevel}%` : state.capitalPriority}.`); break;
      case 9: if (state.classification.xyz === 'Y') this.pushLog(`<b>Gate Y-SEASON</b> — ${state.seasonality === 'confirmed' ? 'Đạt: mở Holt-Winters.' : 'Không đạt.'}`); break;
      case 10: if (state.classification.xyz === 'Y' && state.seasonality !== 'confirmed') this.pushLog(`<b>Gate Y-TREND</b> — ${state.trend === 'up' || state.trend === 'down' ? 'Đạt: mở Holt.' : 'Không đạt: dùng SES.'}`); break;
      case 11: this.pushLog(`<b>Chặng 11</b> — Khoá mô hình nền: <b>${state.forecast?.model ?? '—'}</b>.`); break;
      case 12: this.pushLog(`<b>Chặng 12</b> — Hệ số CTKM: ${state.promoFactor != null ? state.promoFactor.toFixed(2) : 'không có'} (${state.promoConfidence}).`); break;
      case 13: this.pushLog(`<b>Chặng 13</b> — Dự báo cuối đã áp CTKM cho ${state.finalForecast.length} chu kỳ.`); break;
      case 14: this.pushLog(`<b>Chặng 14</b> — Hàng tự do: ${state.freeStock ?? 0}.`); break;
      case 15: this.pushLog(`<b>Chặng 15</b> — Tồn an toàn: ${state.safetyStock ?? 'chính sách riêng'}.`); break;
      case 16: this.pushLog(`<b>Chặng 16</b> — Số đặt sau MOQ: ${state.orderPlan?.orderQuantity ?? '—'}.`); break;
      case 17: this.pushLog(`<b>Chặng 17</b> — Số được cấp vốn: ${state.budgetAllocation?.fundedQuantity ?? '—'}.`); break;
      case 18: this.pushLog(`<b>Chặng 18</b> — Trạng thái phát hành: ${state.releaseDecision?.status ?? '—'}.`); break;
      case 19: this.pushLog(`<b>Chặng 19</b> — Hậu kiểm hoàn tất.`); break;
      default: this.pushLog(`<b>Chặng ${stage}</b> — hoàn tất.`);
    }
  }

  /** Chạy pipeline thật của toàn app (giống nút "Chạy tất cả" ở màn hình chính) — không có bản demo riêng. */
  runSimulation(): void { this.store.runAll(); }

  /** Đặt lại toàn phiên — dùng chung SimulationStore nên cũng đặt lại các panel khác của app. */
  resetAll(): void { this.store.reset(); }
}

function svgQuery(root: SVGSVGElement, selector: string): SVGGElement | null {
  return root.querySelector<SVGGElement>(selector);
}
