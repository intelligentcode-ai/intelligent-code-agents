import React from "react";

export interface DesktopMasterDetailShellProps {
  list: React.ReactNode;
  detail: React.ReactNode;
}

export function DesktopMasterDetailShell({ list, detail }: DesktopMasterDetailShellProps): JSX.Element {
  return (
    <section className="desktop-master-detail-shell">
      <aside className="desktop-master-detail-list">{list}</aside>
      <div className="desktop-master-detail-detail">{detail}</div>
    </section>
  );
}

export interface DesktopSelectionRecordProps {
  title: string;
  subtitle: string;
  meta?: string;
  active?: boolean;
  onClick: () => void;
  footer?: React.ReactNode;
}

export function DesktopSelectionRecord({
  title,
  subtitle,
  meta,
  active = false,
  onClick,
  footer,
}: DesktopSelectionRecordProps): JSX.Element {
  return (
    <button className={`desktop-record-button ${active ? "is-active" : ""}`} type="button" onClick={onClick}>
      <span className="desktop-record-title">{title}</span>
      <span className="desktop-record-subtitle">{subtitle}</span>
      {meta && <span className="desktop-record-meta">{meta}</span>}
      {footer}
    </button>
  );
}
