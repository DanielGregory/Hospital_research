import { useEffect, useState, type ReactNode } from 'react';
import { applyTheme, loadTheme, NEXT_THEME, THEME_LABEL } from '../theme';

export function Shell(props: { crumb?: string; onHome: () => void; children: ReactNode }) {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <>
      <header className="topbar">
        <button className="wordmark" onClick={props.onHome} aria-label="ER Planner, back to the start">
          <span className="wordmark-cross" aria-hidden />
          ER Planner
        </button>
        {props.crumb && <span className="crumb">/ {props.crumb}</span>}
        <span className="spacer" />
        <button className="theme-toggle ghost" onClick={() => setTheme(NEXT_THEME[theme])} data-testid="theme">
          {THEME_LABEL[theme]}
        </button>
      </header>
      {props.children}
    </>
  );
}
