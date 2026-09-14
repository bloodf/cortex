import { cva, type VariantProps } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
        warning: "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90",
        info: "bg-[var(--chart-2)] text-background shadow-sm hover:bg-[var(--chart-2)]/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        "outline-success":
          "border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-[var(--success)] [&_svg]:text-[var(--success)] [&_svg]:transition-all [&_svg]:duration-150 [&_svg]:stroke-[1.5] hover:[&_svg]:stroke-[2.5]",
        "outline-destructive":
          "border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-[var(--destructive)] [&_svg]:text-[var(--destructive)] [&_svg]:transition-all [&_svg]:duration-150 [&_svg]:stroke-[1.5] hover:[&_svg]:stroke-[2.5]",
        "outline-warning":
          "border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-[var(--warning)] [&_svg]:text-[var(--warning)] [&_svg]:transition-all [&_svg]:duration-150 [&_svg]:stroke-[1.5] hover:[&_svg]:stroke-[2.5]",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        // Compact icon size used by ai-elements (message actions, branch nav).
        "icon-sm": "size-8 rounded-md p-0 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
