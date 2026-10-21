import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { createMockApi } from "../api/mockApi";

export function renderApp(path = "/") {
  const user = userEvent.setup();
  const api = createMockApi({ latencyMs: 0 });
  const utils = render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App api={api} />
    </MemoryRouter>,
  );
  return { user, api, ...utils };
}
