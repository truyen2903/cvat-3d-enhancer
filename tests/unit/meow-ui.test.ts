import { afterEach, describe, expect, it } from 'vitest';
import {
  decorateMeowSurface,
  ensureMeowStyle,
  removeMeowUi,
} from '../../src/integration/cvat/runtime/meow-ui';

afterEach(() => {
  removeMeowUi(document);
  document.body.replaceChildren();
  document.documentElement.className = '';
});

describe('shared Meow UI styles', () => {
  it('injects one style across surfaces and removes it on teardown', () => {
    ensureMeowStyle(document);
    ensureMeowStyle(document);
    expect(document.querySelectorAll('#meow-ui-style')).toHaveLength(1);
    removeMeowUi(document);
    expect(document.querySelector('#meow-ui-style')).toBeNull();
    ensureMeowStyle(document);
    expect(document.querySelectorAll('#meow-ui-style')).toHaveLength(1);
  });

  it('reuses CVAT hash and provides an explicit dark class fallback for portals', () => {
    document.body.innerHTML = '<div class="cvat-workspace-settings css-native"></div>';
    document.documentElement.classList.add('dark');
    const panel = document.createElement('div');
    decorateMeowSurface(panel);
    expect(panel.classList.contains('css-native')).toBe(true);
    expect(panel.classList.contains('meow-dark')).toBe(true);
    ensureMeowStyle(document);
    expect(document.querySelector('#meow-ui-style')?.textContent).toContain('.meow-dark');
  });
});
