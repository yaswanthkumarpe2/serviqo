import { cn } from "@/utils/cn";

interface AvatarProps {
  initials: string;
  background: string;
  size?: number;
  className?: string;
}

/** Squircle initials avatar — inbox rows and the hero demo's agent header. */
export function Avatar({ initials, background, size = 26, className }: AvatarProps) {
  return (
    <div className={cn("im__av", className)} style={{ background, width: size, height: size }}>
      {initials}
    </div>
  );
}
