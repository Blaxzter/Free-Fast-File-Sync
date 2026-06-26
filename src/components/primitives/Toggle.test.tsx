import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("renders a switch (not a checkbox) labelled by its text", () => {
    render(<Toggle label="Use recycle bin" checked={false} onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Use recycle bin" });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("reflects the checked state via aria-checked", () => {
    render(<Toggle label="On" checked onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the toggled value when clicked", async () => {
    const onChange = vi.fn();
    render(<Toggle label="Toggle me" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch", { name: "Toggle me" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire onChange when disabled", async () => {
    const onChange = vi.fn();
    render(<Toggle label="Locked" checked={false} onChange={onChange} disabled />);
    await userEvent.click(screen.getByRole("switch", { name: "Locked" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
