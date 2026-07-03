import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, output, signal, viewChild } from '@angular/core';
import mermaid from 'mermaid';
import { JOURNEY_DIAGRAM } from '../domain/journey-diagram';

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

@Component({
  selector: 'app-journey-map',
  standalone: true,
  template: `
    <div class="journey-backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <div class="journey-dialog" role="dialog" aria-modal="true" aria-label="Sơ đồ hành trình tổng thể">
      <header class="journey-head">
        <div class="journey-title">
          <span class="journey-glyph" aria-hidden="true">⇶</span>
          <div>
            <p>TÀI LIỆU GIẢI PHÁP · MỤC 2 · 19 CHẶNG / 6 PHA</p>
            <h2>Sơ đồ hành trình tổng thể</h2>
          </div>
        </div>
        <div class="journey-tools">
          <button type="button" (click)="zoomBy(-0.15)" [disabled]="loading()" aria-label="Thu nhỏ">−</button>
          <span class="journey-zoom">{{ zoomLabel() }}</span>
          <button type="button" (click)="zoomBy(0.15)" [disabled]="loading()" aria-label="Phóng to">+</button>
          <button type="button" class="text" (click)="fitWidth()" [disabled]="loading()">Vừa khung</button>
          <button type="button" class="text" (click)="setScale(1)" [disabled]="loading()">100%</button>
          <button type="button" class="close" (click)="closed.emit()" aria-label="Đóng sơ đồ">✕</button>
        </div>
      </header>
      <div class="journey-canvas" #canvas (wheel)="onWheel($event)">
        @if (loading()) { <p class="journey-status">Đang dựng sơ đồ…</p> }
        @if (error()) { <p class="journey-status error">{{ error() }}</p> }
        <div class="journey-svg" #host></div>
      </div>
      <footer class="journey-foot">Cuộn để di chuyển · Ctrl + lăn chuột hoặc nút +/− để phóng to, thu nhỏ · Esc để đóng</footer>
    </div>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; }
    .journey-backdrop { position: absolute; inset: 0; background: rgba(5, 7, 11, .78); backdrop-filter: blur(6px); }
    .journey-dialog { position: relative; display: flex; flex-direction: column; width: min(96vw, 1720px); height: 94vh; border: 1px solid #3a404c; border-radius: 12px; overflow: hidden; background: #0c0f15; box-shadow: 0 40px 120px rgba(0,0,0,.55); }
    .journey-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid #292e3a; background: radial-gradient(circle at 4% 50%, rgba(255,171,46,.1), transparent 26%), #11141b; }
    .journey-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .journey-glyph { display: grid; place-items: center; flex: 0 0 36px; height: 36px; color: #ffab2e; border: 1px solid #63471f; border-radius: 9px; font-size: 18px; }
    .journey-title p { margin: 0; color: #7f8798; font: 700 9px/1.2 "Bahnschrift", sans-serif; letter-spacing: .14em; }
    .journey-title h2 { margin: 4px 0 0; color: #f3f4f7; font: 650 18px "Bahnschrift Condensed", sans-serif; letter-spacing: .02em; }
    .journey-tools { display: flex; align-items: center; gap: 6px; }
    .journey-tools button { min-width: 30px; height: 30px; padding: 0 9px; color: #d9dee8; border: 1px solid #292e3a; border-radius: 6px; background: #151922; font: 700 13px "Cascadia Code", monospace; cursor: pointer; transition: .15s ease; }
    .journey-tools button:hover:not(:disabled) { border-color: #50586a; color: #fff; }
    .journey-tools button:disabled { opacity: .35; cursor: not-allowed; }
    .journey-tools button.text { font: 700 10px "Bahnschrift", sans-serif; letter-spacing: .04em; }
    .journey-tools button.close { margin-left: 10px; color: #ff9d9d; border-color: #673a40; }
    .journey-zoom { min-width: 44px; color: #ffab2e; font: 700 11px "Cascadia Code", monospace; text-align: center; }
    .journey-canvas { position: relative; flex: 1; min-height: 0; overflow: auto; background: linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px), #0a0d12; background-size: 40px 40px, 40px 40px; scrollbar-width: thin; }
    .journey-svg { width: max-content; padding: 24px; }
    .journey-svg ::ng-deep svg { display: block; max-width: none !important; height: auto; }
    .journey-status { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: #7f8798; font-size: 13px; }
    .journey-status.error { color: #ff9d9d; padding: 0 40px; text-align: center; }
    .journey-foot { padding: 8px 16px; border-top: 1px solid #292e3a; color: #555d6e; background: #0d1016; font-size: 10px; letter-spacing: .04em; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JourneyMapComponent implements AfterViewInit {
  readonly closed = output<void>();
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly scale = signal(1);
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly canvas = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
  private naturalWidth = 0;

  zoomLabel(): string { return `${Math.round(this.scale() * 100)}%`; }

  async ngAfterViewInit(): Promise<void> {
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'dark',
        themeVariables: {
          darkMode: true,
          background: '#0a0d12',
          primaryColor: '#161a23',
          primaryBorderColor: '#3a404c',
          primaryTextColor: '#f3f4f7',
          lineColor: '#7f8798',
          clusterBkg: '#11141b',
          clusterBorder: '#41341f',
          titleColor: '#ffab2e',
          edgeLabelBackground: '#151922',
          fontSize: '15px',
        },
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
      });
      const { svg } = await mermaid.render(`journey-${Date.now()}`, JOURNEY_DIAGRAM);
      const hostEl = this.host().nativeElement;
      hostEl.innerHTML = svg;
      const svgEl = hostEl.querySelector('svg');
      this.naturalWidth = svgEl ? svgEl.getBoundingClientRect().width : 0;
      this.loading.set(false);
      this.fitWidth();
    } catch (cause) {
      this.loading.set(false);
      this.error.set(`Không dựng được sơ đồ mermaid: ${cause instanceof Error ? cause.message : cause}`);
    }
  }

  setScale(value: number): void {
    this.scale.set(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)));
    this.applyScale();
  }

  zoomBy(delta: number): void { this.setScale(this.scale() + delta); }

  fitWidth(): void {
    if (!this.naturalWidth) return;
    const available = this.canvas().nativeElement.clientWidth - 48;
    this.setScale(available / this.naturalWidth);
  }

  onWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 0.1 : -0.1);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.closed.emit(); }

  private applyScale(): void {
    const svgEl = this.host().nativeElement.querySelector('svg');
    if (!svgEl || !this.naturalWidth) return;
    svgEl.style.width = `${this.naturalWidth * this.scale()}px`;
    svgEl.style.height = 'auto';
  }
}
