// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogoutForm } from "@/components/logout-form";
import { WorkspaceShell } from "./shell";

afterEach(cleanup);

describe("workspace shell", () => {
  it("gives Profil and Keluar a 44px row in the account menu", () => {
    render(
      <WorkspaceShell
        active="/dasbor"
        projectId="p1"
        projectName="QA Test Brand"
        projects={[{ id: "p1", name: "QA Test Brand", initials: "QT" }]}
        accountName="QA Release"
        accountEmail="qa@example.com"
        initials="QR"
        attention={0}
        uncertain={0}
        logout={<LogoutForm buttonClassName="h-11 min-h-11 w-full justify-start px-2" />}
      >
        <p>Konten</p>
      </WorkspaceShell>,
    );
    const profil = screen.getAllByRole("link", { name: "Profil" })[0];
    const keluar = screen.getAllByRole("button", { name: "Keluar" })[0];
    expect(profil?.className).toContain("min-h-11");
    expect(keluar?.className).toContain("min-h-11");
    expect(keluar?.className).toContain("h-11");
  });

  it("gives the mobile project switcher a 44px target at 390px", () => {
    const view = document.createElement("div");
    view.style.width = "390px";
    document.body.appendChild(view);
    render(
      <WorkspaceShell
        active="/dasbor"
        projectId="p1"
        projectName="QA Test Brand"
        projects={[
          { id: "p1", name: "QA Test Brand", initials: "QT" },
          { id: "p2", name: "Merek lain", initials: "ML" },
        ]}
        accountName="QA Release"
        accountEmail="qa@example.com"
        initials="QR"
        attention={0}
        uncertain={0}
      >
        <p>Konten</p>
      </WorkspaceShell>,
      { container: view },
    );
    fireEvent.click(screen.getByRole("button", { name: "Buka menu navigasi" }));
    for (const label of screen.getAllByText("Proyek")) {
      const summary = label.closest("summary");
      if (summary) fireEvent.click(summary);
    }
    const summary = screen.getAllByText("QA Test Brand")[0]?.closest("summary");
    expect(summary?.className ?? "").toMatch(/min-h-\[44px\]|min-h-11/);
    const projects = screen.getAllByRole("link", { name: "Merek lain" });
    const allProjects = screen.getAllByRole("link", { name: "Semua proyek" });
    expect(projects.length).toBeGreaterThan(0);
    for (const link of [...projects, ...allProjects]) {
      expect(link.className).toMatch(/min-h-\[44px\]|min-h-11/);
      expect(link.className).not.toMatch(/w-\[\d{3,}px\]/);
    }
    expect(view.style.width).toBe("390px");
  });
});
