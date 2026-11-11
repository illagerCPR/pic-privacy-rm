import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 20, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3l7 2.5v5.2c0 5.2-3.1 8.8-7 11-3.9-2.2-7-5.8-7-11V5.5L12 3z" />
      <path d="M9.2 12.1l2 2 3.6-3.9" />
    </Base>
  );
}

export function ImagePlusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="4" width="13" height="16" rx="2.5" />
      <circle cx="7.5" cy="9" r="1.4" />
      <path d="M4 16.5l3.5-3.6 2.4 2.5 3.1-3.4 2.2 2.3" />
      <path d="M18.5 8.5h4M20.5 6.5v4" />
    </Base>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7.5A2.5 2.5 0 015.5 5h3.2l1.8 2h8A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z" />
    </Base>
  );
}

export function ClipboardIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="6" y="4.5" width="12" height="16" rx="2" />
      <path d="M9.5 4.5V3.4c0-.5.4-.9.9-.9h3.2c.5 0 .9.4.9.9v1.1" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" />
    </Base>
  );
}

export function TableIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.8 4.5v15M14.6 4.5v15" />
    </Base>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 4v10.5" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 18.5h15" />
    </Base>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Base>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 7h15M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7" />
      <path d="M6.5 7l.8 12.1c0 .5.5.9 1 .9h7.4c.5 0 1-.4 1-.9L18 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </Base>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9 5l7 7-7 7" />
    </Base>
  );
}

export function MapPinIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 21s6.5-5.4 6.5-10.2A6.5 6.5 0 005.5 10.8C5.5 15.6 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </Base>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 8.5A2 2 0 015.5 6.5h1.7l1.2-1.8h5.2l1.2 1.8h1.7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2v-8z" />
      <circle cx="11.5" cy="12.2" r="3.2" />
    </Base>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.6V12l3 1.9" />
    </Base>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 4.2l8.2 14.6H3.8L12 4.2z" />
      <path d="M12 9.4v4.2" />
      <circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Base>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" />
    </Base>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20 14.6A8.6 8.6 0 019.4 4a8.6 8.6 0 1010.6 10.6z" />
    </Base>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3.2" y="4.6" width="17.6" height="12" rx="2" />
      <path d="M9 20h6M12 16.6V20" />
    </Base>
  );
}

export function GithubIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9.2 20.2v-2.3c-3 .5-3.9-1.4-3.9-1.4-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.4-.3-4.9-1.2-4.9-5.4 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10 10 0 015.4 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.8 1.1 3 0 4.2-2.5 5.1-4.9 5.4.4.4.7 1 .7 2.1v3.1" />
    </Base>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.2 10.5V8a3.8 3.8 0 017.6 0v2.5" />
    </Base>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 4l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16l8 4 8-4" />
    </Base>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11v5.2" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 3.5h7l4 4v13a1.5 1.5 0 01-1.5 1.5h-9.5A1.5 1.5 0 015 20.5v-15A1.5 1.5 0 016.5 3.5z" />
      <path d="M13.5 3.5V8h4" />
    </Base>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20 11.5A8 8 0 006.4 6.6L4.5 8.5" />
      <path d="M4 4.5v4h4" />
      <path d="M4 12.5a8 8 0 0013.6 4.9l1.9-1.9" />
      <path d="M20 19.5v-4h-4" />
    </Base>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </Base>
  );
}
