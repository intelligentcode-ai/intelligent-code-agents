import React from "react";
import {
  accentOptions,
  backgroundOptions,
  modeOptions,
  type DashboardAccent,
  type DashboardBackground,
  type DashboardMode,
} from "./appearance";

interface DesktopAppearanceSettingsProps {
  mode: DashboardMode;
  accent: DashboardAccent;
  background: DashboardBackground;
  onModeChange(mode: DashboardMode): void;
  onAccentChange(accent: DashboardAccent): void;
  onBackgroundChange(background: DashboardBackground): void;
}

export function DesktopAppearanceSettings({
  mode,
  accent,
  background,
  onModeChange,
  onAccentChange,
  onBackgroundChange,
}: DesktopAppearanceSettingsProps): JSX.Element {
  return (
    <article className="panel panel-settings panel-spacious">
      <p className="eyebrow">Desktop Preferences</p>
      <h2>Appearance & Theme</h2>
      <p className="subtle">Theme controls live in the dedicated Settings window so the main shell stays focused on workspace operations.</p>
      <div className="theme-row">
        <div className="theme-group">
          <span className="theme-label">Theme</span>
          <div className="theme-buttons">
            {modeOptions.map((option) => (
              <button
                key={option.id}
                className={`theme-btn ${mode === option.id ? "is-active" : ""}`}
                type="button"
                onClick={() => onModeChange(option.id)}
                aria-pressed={mode === option.id}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="theme-group theme-group-accent">
          <span className="theme-label">Accent</span>
          <div className="theme-buttons">
            {accentOptions.map((option) => (
              <button
                key={option.id}
                className={`theme-btn theme-btn-accent ${accent === option.id ? "is-active" : ""}`}
                type="button"
                onClick={() => onAccentChange(option.id)}
                aria-pressed={accent === option.id}
                data-accent={option.id}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="theme-group theme-group-wide">
        <span className="theme-label">Background</span>
        <div className="theme-buttons">
          {backgroundOptions.map((option) => (
            <button
              key={option.id}
              className={`theme-btn theme-btn-background ${background === option.id ? "is-active" : ""}`}
              type="button"
              onClick={() => onBackgroundChange(option.id)}
              aria-pressed={background === option.id}
              data-background={option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}
