"use client";

import { Block, Button } from "@lobehub/ui";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import { Shimmer } from "./shimmer";

interface PlanContextValue {
  isStreaming: boolean;
}

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("Plan components must be used within Plan");
  }
  return context;
};

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export const Plan = ({ className, isStreaming = false, children, ...props }: PlanProps) => {
  const contextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <PlanContext.Provider value={contextValue}>
      <Collapsible asChild data-slot="plan" {...props}>
        <Block
          variant="outlined"
          className={cn("bg-card text-card-foreground shadow-none", className)}
        >
          {children}
        </Block>
      </Collapsible>
    </PlanContext.Provider>
  );
};

export type PlanHeaderProps = ComponentProps<"div">;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <div
    className={cn("flex items-start justify-between space-y-1.5 p-6", className)}
    data-slot="plan-header"
    {...props}
  />
);

export type PlanTitleProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
};

export const PlanTitle = ({ className, children, ...props }: PlanTitleProps) => {
  const { isStreaming } = usePlan();

  return (
    <div
      className={cn("font-semibold leading-none tracking-tight", className)}
      data-slot="plan-title"
      {...props}
    >
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </div>
  );
};

export type PlanDescriptionProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
};

export const PlanDescription = ({ className, children, ...props }: PlanDescriptionProps) => {
  const { isStreaming } = usePlan();

  return (
    <div
      className={cn("text-balance text-sm text-muted-foreground", className)}
      data-slot="plan-description"
      {...props}
    >
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </div>
  );
};

export type PlanActionProps = ComponentProps<"div">;

export const PlanAction = ({ className, ...props }: PlanActionProps) => (
  <div
    className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
    data-slot="plan-action"
    {...props}
  />
);

export type PlanContentProps = ComponentProps<"div">;

export const PlanContent = ({ className, ...props }: PlanContentProps) => (
  <CollapsibleContent asChild>
    <div className={cn("p-6 pt-0", className)} data-slot="plan-content" {...props} />
  </CollapsibleContent>
);

export type PlanFooterProps = ComponentProps<"div">;

export const PlanFooter = ({ className, ...props }: PlanFooterProps) => (
  <div className={cn("flex items-center p-6 pt-0", className)} data-slot="plan-footer" {...props} />
);

export type PlanTriggerProps = ComponentProps<typeof Button>;

export const PlanTrigger = ({ className, ...props }: PlanTriggerProps) => (
  <CollapsibleTrigger asChild>
    <Button
      className={cn("size-8", className)}
      data-slot="plan-trigger"
      htmlType="button"
      icon={<ChevronsUpDownIcon className="size-4" />}
      shape="circle"
      size="small"
      variant="text"
      {...props}
    >
      <span className="sr-only">Toggle plan</span>
    </Button>
  </CollapsibleTrigger>
);
