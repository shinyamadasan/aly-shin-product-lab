import type React from "react";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; helper?: string }) {
  const { label, helper, ...inputProps } = props;
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" {...inputProps} />
      {helper ? <span className="text-xs font-normal leading-5 text-[#6f5a4c]">{helper}</span> : null}
    </label>
  );
}

export function Textarea({ label, helper, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; helper?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea className="min-h-20 rounded-md border border-[#d8c7b7] bg-white p-3" {...props} />
      {helper ? <span className="text-xs font-normal leading-5 text-[#6f5a4c]">{helper}</span> : null}
    </label>
  );
}

export function Select({ label, options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: string[] }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" {...props}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

export function Button({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  return <button className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427] disabled:cursor-not-allowed disabled:opacity-60" disabled={disabled} type="submit">{children}</button>;
}

export function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button className="h-10 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d] hover:bg-[#fffaf3]" onClick={onClick} type="button">{children}</button>;
}

export function HeaderBadge({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-[#e1d4c4] bg-white px-4 py-2"><p className="text-xs font-medium uppercase tracking-[0.14em] text-[#8a7465]">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>;
}

export function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: number; detail: string }) {
  return <div className="rounded-md border border-[#ead9c8] bg-white p-4"><div className="flex items-center justify-between"><p className="text-sm font-medium text-[#6f5a4c]">{label}</p><span className="text-[#9a5b2f]">{icon}</span></div><p className="mt-3 text-3xl font-semibold">{value}</p><p className="mt-1 text-sm text-[#6f5a4c]">{detail}</p></div>;
}

export function Tag({ children, tone }: { children: React.ReactNode; tone: "warm" | "green" | "danger" }) {
  const styles = { warm: "bg-[#f5eadf] text-[#7c4828]", green: "bg-[#e9f3ed] text-[#2e6b44]", danger: "bg-[#fde6df] text-[#8a3827]" };
  return <span className={`rounded-sm px-2 py-1 text-xs font-medium ${styles[tone]}`}>{children}</span>;
}

export function StatusPill({ label, done }: { label: string; done: boolean }) {
  return <span className={`rounded-sm px-2 py-1 text-xs font-medium ${done ? "bg-[#e9f3ed] text-[#2e6b44]" : "bg-[#fff2d8] text-[#7a531d]"}`}>{done ? "Done" : "Needed"}: {label}</span>;
}

export function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <aside className="rounded-lg border border-[#e1d4c4] bg-white p-5"><div className="mb-4 flex items-center gap-2"><span className="text-[#9a5b2f]">{icon}</span><h3 className="font-semibold">{title}</h3></div>{children}</aside>;
}

export function FormPanel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-lg border border-[#e1d4c4] bg-white p-5"><div className="mb-4 flex items-center gap-2"><span className="text-[#9a5b2f]">{icon}</span><h3 className="text-lg font-semibold">{title}</h3></div>{children}</section>;
}

export function MessageBox({
  message,
  tone,
  dark = false,
}: {
  message: string;
  tone: "good" | "bad" | "info";
  dark?: boolean;
}) {
  const styles = {
    good: dark ? "bg-emerald-500/15 text-emerald-50" : "bg-emerald-50 text-emerald-800",
    bad: dark ? "bg-red-500/15 text-red-50" : "bg-red-50 text-red-800",
    info: dark ? "bg-white/10 text-[#fff8ef]" : "bg-[#fff2d8] text-[#7a531d]",
  };

  return <p className={`mt-4 rounded-md p-3 text-sm ${styles[tone]}`}>{message}</p>;
}
