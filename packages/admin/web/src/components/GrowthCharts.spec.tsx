import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GrowthCharts, PlanMixChart } from "./GrowthCharts.js";

describe("GrowthCharts", () => {
  it("renders empty state when history is empty", () => {
    render(<GrowthCharts items={[]} />);

    expect(screen.getByTestId("growth-charts-empty")).toBeTruthy();
    expect(screen.getByText("No growth history yet")).toBeTruthy();
  });
});

describe("PlanMixChart", () => {
  it("renders empty state when there is no snapshot", () => {
    render(<PlanMixChart items={[]} />);

    expect(screen.getByTestId("plan-mix-chart-empty")).toBeTruthy();
    expect(screen.getByText("No plan mix data")).toBeTruthy();
  });
});
