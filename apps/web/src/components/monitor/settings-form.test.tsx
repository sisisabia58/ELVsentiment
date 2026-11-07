// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsForm } from "./settings-form";

afterEach(cleanup);

describe("project settings", () => {
  it("keeps Tambahkan inside the keyword row by letting the field shrink", () => {
    render(
      <SettingsForm
        projectId="p1"
        brandName="QA Test Brand"
        keywords={["qa test brand"]}
        sources={["x"]}
        schedule={{ mode: "off", intervalHours: 6 }}
        credentials={{ x: true, threads: false }}
      />,
    );
    const input = screen.getByLabelText("Variasi kata kunci");
    expect(input.className).toContain("min-w-0");
    expect(input.parentElement?.className).toContain("min-w-0");
    expect(screen.getByRole("button", { name: "Tambahkan" }).className).toContain("shrink-0");
  });

  it("marks a source with no server key as unavailable and not selected", () => {
    render(
      <SettingsForm
        projectId="p1"
        brandName="QA Test Brand"
        keywords={["qa test brand"]}
        sources={["x", "threads"]}
        schedule={{ mode: "off", intervalHours: 6 }}
        credentials={{ x: true, threads: false }}
      />,
    );
    const threads = screen.getByRole("checkbox", { name: /^Threads/ }) as HTMLInputElement;
    const x = screen.getByRole("checkbox", { name: /^X/ }) as HTMLInputElement;
    expect(threads.disabled).toBe(true);
    expect(threads.checked).toBe(false);
    expect(screen.getByText("Sumber Threads sedang tidak tersedia, kami sedang memperbaikinya.")).toBeTruthy();
    expect(x.disabled).toBe(false);
    expect(x.checked).toBe(true);
    expect(screen.queryByText(/Asia\/Jakarta/)).toBeNull();
    expect(screen.getByText(/WIB/)).toBeTruthy();
  });
});
