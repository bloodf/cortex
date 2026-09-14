import { useEffect, useMemo, useState } from "react";
import { BRAND_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { LOBE_ICONS } from "./tech-icon-map";

interface Props {
  slug: string;
  name: string;
  size?: number;
  className?: string;
  /** Explicit operator-configured icon URL; never derived from a private identifier. */
  iconImage?: string | null;
}

type Candidate = { kind: "img"; src: string } | { kind: "lobe"; Icon: (typeof LOBE_ICONS)[string] };

function mix(hex: string): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 0.7;
  const m = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * f)))
      .toString(16)
      .padStart(2, "0");
  return `#${m(r)}${m(g)}${m(b)}`;
}

export function TechIcon({ slug, name, size = 32, className, iconImage }: Props) {
  // Explicit operator icon -> bundled brand -> local monogram.
  // Never disclose service slugs or container names to a third-party icon CDN.
  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [];
    if (iconImage && /^(?:https?:\/\/|\/(?![/\\])|data:image\/)/i.test(iconImage)) {
      list.push({ kind: "img", src: iconImage });
    }
    const LobeIcon = LOBE_ICONS[slug];
    if (LobeIcon) list.push({ kind: "lobe", Icon: LobeIcon });
    return list;
  }, [slug, iconImage]);

  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [slug, iconImage]);
  const current = candidates[Math.min(step, candidates.length)];

  if (current?.kind === "lobe") {
    const { Icon } = current;
    return <Icon size={size} title={name} role="img" className={cn("shrink-0", className)} />;
  }

  if (current?.kind === "img") {
    return (
      <img
        src={current.src}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setStep((s) => s + 1)}
        className={cn("rounded-md object-contain shrink-0", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  const color = BRAND_COLORS[slug] ?? "oklch(0.55 0.18 277)";
  const monogram = name.slice(0, 2).toUpperCase();
  // simple deterministic gradient end
  const c2 = mix(color);
  return (
    <div
      role="img"
      aria-label={name}
      className={cn(
        "flex items-center justify-center rounded-md font-semibold text-white shadow-sm shrink-0",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.38),
        background: `linear-gradient(135deg, ${color}, ${c2})`,
      }}
    >
      {monogram}
    </div>
  );
}
