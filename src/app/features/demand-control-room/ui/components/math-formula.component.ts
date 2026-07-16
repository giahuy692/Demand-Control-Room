import { ChangeDetectionStrategy, Component, ElementRef, Input, OnChanges, inject } from '@angular/core';

@Component({
  selector: 'app-math-formula',
  standalone: true,
  template: '',
  host: {
    class: 'math-formula',
    role: 'img',
    '[attr.aria-label]': 'label',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MathFormulaComponent implements OnChanges {
  @Input({ required: true }) expression = '';
  @Input() label = 'Công thức tính';

  private readonly element = inject(ElementRef<HTMLElement>);
  private renderVersion = 0;

  ngOnChanges(): void {
    const version = ++this.renderVersion;
    void import('katex').then(({ renderToString }) => {
      if (version !== this.renderVersion) return;
      this.element.nativeElement.innerHTML = renderToString(this.expression, {
        displayMode: true,
        output: 'htmlAndMathml',
        throwOnError: false,
        strict: 'ignore',
      });
    });
  }
}
