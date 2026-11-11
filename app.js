(() => {
  "use strict";

  const config = window.APP_CONFIG || {};
  const configReady = config.supabaseUrl && config.supabaseAnonKey
    && !config.supabaseUrl.includes("YOUR-PROJECT")
    && !config.supabaseAnonKey.includes("YOUR_SUPABASE");
  const client = configReady && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
    : null;
  const state = {
    mechanics: [], admin: false, user: null, channel: null, toastTimer: null,
    businessDate: null, promptedOpeningDate: null, queueSaving: false,
    mutationInProgress: false, realtimeRefreshQueued: false, realtimeRefreshTimer: null
  };
  const $ = (selector) => document.querySelector(selector);
  const board = $("#mechanic-board");
  const notice = $("#notice");
  const loading = $("#loading");
  const adminPanel = $("#admin-panel");
  const adminUsernames = new Set(["caio", "gustavo", "fernando", "victor"]);
  const authEmailForUsername = (username) => `${username}@usuarios.gestaopatio.invalid`;

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4200);
  }

  function showError(error, context) {
    console.error(context, error);
    showToast(`${context}: ${error.message || "erro inesperado"}`, true);
  }

  function localDate() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function statusLabel(status) {
    return ({ available: "DISPONÍVEL", maintenance: "EM MANUTENÇÃO", pause: "PAUSA", absent: "AUSENTE" })[status] || status;
  }

  function normalizePlate(value) {
    return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  }

  function renderWithMovement(container, render) {
    const previousPositions = new Map(
      [...container.children]
        .filter((element) => element.dataset.mechanicId)
        .map((element) => [element.dataset.mechanicId, element.getBoundingClientRect()])
    );
    render();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    [...container.children].forEach((element) => {
      const previous = previousPositions.get(element.dataset.mechanicId);
      if (!previous) return;
      const current = element.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      if (deltaX || deltaY) {
        element.animate(
          [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: "translate(0, 0)" }],
          { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" }
        );
      }
    });
  }

  function createMechanicCard(mechanic, positionValue = null) {
    const card = document.createElement("article");
    card.className = `mechanic-card ${mechanic.status === "maintenance" ? "maintenance-card" : "available-card"}`;
    card.dataset.mechanicId = mechanic.id;

    if (mechanic.status !== "maintenance" && positionValue !== null) {
      const position = document.createElement("span");
      position.className = "position";
      position.textContent = String(positionValue).padStart(2, "0");
      card.append(position);
    }

    const info = document.createElement("div");
    info.className = "mechanic-info";
    const name = document.createElement("h2");
    name.className = "mechanic-name";
    name.textContent = mechanic.name;
    const vehicle = document.createElement("p");
    vehicle.className = "vehicle-label";
    if (mechanic.status === "maintenance") {
      const details = [mechanic.vehicle_model, mechanic.vehicle_plate].filter(Boolean);
      vehicle.textContent = details.length ? details.join(" | ") : " ";
    } else {
      vehicle.textContent = mechanic.status === "available" ? "Disponível" : statusLabel(mechanic.status);
    }
    info.append(name, vehicle);
    card.append(info);

    const status = document.createElement("span");
    status.className = `status status-${mechanic.status}`;
    status.textContent = statusLabel(mechanic.status);
    card.append(status);

    return card;
  }

  function renderBoard() {
    renderWithMovement(board, () => {
      board.replaceChildren();

      const sortedMechanics = [...state.mechanics].sort((a, b) => (a.queue_position ?? 9999) - (b.queue_position ?? 9999));
      const availableMechanics = sortedMechanics.filter((mechanic) => mechanic.status === "available");
      const maintenanceMechanics = sortedMechanics.filter((mechanic) => mechanic.status === "maintenance");
      const otherMechanics = sortedMechanics.filter((mechanic) => !["available", "maintenance"].includes(mechanic.status));

      const availableColumn = document.createElement("div");
      availableColumn.className = "board-column";
      const availableTitle = document.createElement("h2");
      availableTitle.className = "board-column-title";
      availableTitle.textContent = "MECÂNICOS DISPONÍVEIS";
      availableColumn.append(availableTitle);

      if (!availableMechanics.length) {
        const empty = document.createElement("p");
        empty.className = "empty-column";
        empty.textContent = "Nenhum mecânico disponível.";
        availableColumn.append(empty);
      } else {
        availableMechanics.forEach((mechanic, index) => {
          availableColumn.append(createMechanicCard(mechanic, index + 1));
        });
      }

      const maintenanceColumn = document.createElement("div");
      maintenanceColumn.className = "board-column";
      const maintenanceTitle = document.createElement("h2");
      maintenanceTitle.className = "board-column-title";
      maintenanceTitle.textContent = "EM MANUTENÇÃO";
      maintenanceColumn.append(maintenanceTitle);

      if (!maintenanceMechanics.length) {
        const empty = document.createElement("p");
        empty.className = "empty-column";
        empty.textContent = "Nenhum mecânico em manutenção.";
        maintenanceColumn.append(empty);
      } else {
        maintenanceMechanics.forEach((mechanic) => {
          maintenanceColumn.append(createMechanicCard(mechanic));
        });
      }

      const otherColumn = document.createElement("div");
      otherColumn.className = "board-column";
      const otherTitle = document.createElement("h2");
      otherTitle.className = "board-column-title";
      otherTitle.textContent = "PAUSA / AUSENTES";
      otherColumn.append(otherTitle);
      if (!otherMechanics.length) {
        const empty = document.createElement("p");
        empty.className = "empty-column";
        empty.textContent = "Nenhum mecânico fora da fila.";
        otherColumn.append(empty);
      } else {
        otherMechanics.forEach((mechanic) => otherColumn.append(createMechanicCard(mechanic)));
      }

      board.append(availableColumn, maintenanceColumn, otherColumn);
    });
    loading.hidden = true;
  }

  function renderCompletedVehicles(vehicles) {
    const container = document.getElementById("completed-vehicles");
    if (!container) return;
    container.replaceChildren();

    if (!vehicles.length) {
      const empty = document.createElement("p");
      empty.className = "empty-column completed-empty";
      empty.textContent = "Nenhum veículo finalizado hoje.";
      container.append(empty);
      return;
    }

    vehicles.forEach((vehicle) => {
      const card = document.createElement("article");
      card.className = "completed-vehicle-card";

      const model = document.createElement("span");
      model.className = "completed-vehicle-model";
      model.textContent = vehicle.model || "Veículo";

      const plate = document.createElement("span");
      plate.className = "completed-vehicle-plate";
      plate.textContent = vehicle.plate || "—";

      const status = document.createElement("span");
      status.className = "completed-vehicle-status";
      status.textContent = "FINALIZADO";

      card.append(model, plate, status);
      container.append(card);
    });
  }

  async function loadCompletedVehicles() {
    if (!client) return;
    const today = new Date();
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setHours(23, 59, 59, 999);

    let result = await client.from("vehicles")
      .select("id,model,plate,completed_at")
      .eq("status", "completed")
      .gte("completed_at", start.toISOString())
      .lte("completed_at", end.toISOString())
      .order("completed_at", { ascending: false });
    if (result.error && /plate/i.test(result.error.message || "")) {
      result = await client.from("vehicles")
        .select("id,model,completed_at")
        .eq("status", "completed")
        .gte("completed_at", start.toISOString())
        .lte("completed_at", end.toISOString())
        .order("completed_at", { ascending: false });
    }

    const { data, error } = result;
    if (error) throw error;
    renderCompletedVehicles(data || []);
  }

  async function loadBoard() {
    let result = await client.from("mechanics")
      .select("id,name,queue_position,status,vehicle_model,vehicle_plate")
      .order("queue_position");
    if (result.error && /vehicle_plate/i.test(result.error.message || "")) {
      result = await client.from("mechanics")
        .select("id,name,queue_position,status,vehicle_model")
        .order("queue_position");
    }
    const { data, error } = result;
    if (error) throw error;
    state.mechanics = data || [];
    renderBoard();
    if (state.admin) renderAdminData();
    await Promise.all([
      loadCounts(),
      loadCompletedVehicles()
    ]);
    if (state.admin) {
      await Promise.all([loadOpeningState(), loadWaitingVehicles()]);
    }
    $("#updated-at").textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"
    }).format(new Date())}`;
  }

  async function loadCounts() {
    const { data, error } = await client.from("daily_metrics")
      .select("entries_count,completed_count")
      .eq("business_date", localDate()).maybeSingle();
    if (error) throw error;
    $("#entries-count").textContent = String(data?.entries_count ?? 0).padStart(2, "0");
    $("#completed-count").textContent = String(data?.completed_count ?? 0).padStart(2, "0");
  }

  function scheduleRealtimeRefresh() {
    if (state.mutationInProgress) {
      state.realtimeRefreshQueued = true;
      return;
    }
    window.clearTimeout(state.realtimeRefreshTimer);
    state.realtimeRefreshTimer = window.setTimeout(() => refresh(), 140);
  }

  function connectRealtime() {
    if (state.channel) client.removeChannel(state.channel);
    state.channel = client.channel("patio-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "mechanics" }, scheduleRealtimeRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_metrics" }, () => loadCounts().catch((e) => showError(e, "Falha ao atualizar contadores")))
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicles" }, () => {
        loadCompletedVehicles().catch((e) => showError(e, "Falha ao atualizar veículos finalizados"));
        if (state.admin) loadWaitingVehicles().catch((e) => showError(e, "Falha ao atualizar veículos"));
      })
      .subscribe((status) => {
        const label = $("#connection-label");
        label.textContent = status === "SUBSCRIBED" ? "Ao vivo" : status === "CHANNEL_ERROR" ? "Sem sincronização" : "Conectando...";
        $(".live-dot").classList.toggle("online", status === "SUBSCRIBED");
      });
  }

  let refreshPending = false;
  let refreshAgain = false;
  async function refresh() {
    if (refreshPending) {
      refreshAgain = true;
      return;
    }
    refreshPending = true;
    try {
      do {
        refreshAgain = false;
        await loadBoard();
      } while (refreshAgain);
    }
    catch (error) { showError(error, "Falha ao sincronizar"); }
    finally { refreshPending = false; }
  }

  async function callRpc(name, args, success) {
    state.mutationInProgress = true;
    try {
      const { error } = await client.rpc(name, args);
      if (error) throw error;
      showToast(success);
    } finally {
      state.mutationInProgress = false;
      state.realtimeRefreshQueued = false;
    }
    await refresh();
  }

  async function checkAdmin(user) {
    if (!user) return false;
    const { data, error } = await client.rpc("is_admin");
    if (error) throw error;
    return data === true;
  }

  async function updateAuthView() {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    state.user = data.session?.user || null;
    state.admin = await checkAdmin(state.user);
    $("#login-form").hidden = state.admin;
    $("#admin-content").hidden = !state.admin;
    $("#logout-button").hidden = !state.admin;
    if (state.user && !state.admin) {
      await client.auth.signOut();
      state.user = null;
      showToast("Esta conta não tem permissão administrativa.", true);
    }
    await refresh();
  }

  function updateLiveClock() {
    const clock = document.getElementById("live-clock");
    if (!clock) return;
    const now = new Date();
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    clock.textContent = time;
  }

  function startClock() {
    updateLiveClock();
    window.setInterval(updateLiveClock, 1000);
  }

  function showOpeningDialog() {
    const fields = $("#attendance-fields");
    fields.replaceChildren();
    state.mechanics.forEach((mechanic) => {
      const row = document.createElement("label");
      row.className = "attendance-row";
      const name = document.createElement("span");
      name.textContent = mechanic.name;
      const select = document.createElement("select");
      select.dataset.mechanicId = mechanic.id;
      [["present", "Presente"], ["late", "Atrasado"], ["absent", "Ausente"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
      });
      row.append(name, select);
      fields.append(row);
    });
    $("#opening-dialog").showModal();
  }

  async function loadOpeningState() {
    const { data, error } = await client.from("daily_openings")
      .select("work_date,confirmed_at")
      .eq("work_date", localDate()).maybeSingle();
    if (error) throw error;
    const card = $("#opening-card");
    card.replaceChildren();
    const heading = document.createElement("h3");
    const description = document.createElement("p");
    const button = document.createElement("button");
    button.className = "button button-primary";
    button.type = "button";
    if (data) {
      heading.textContent = "Expediente aberto";
      description.textContent = "A confirmação de presença de hoje já foi concluída.";
      button.textContent = "Abertura confirmada";
      button.disabled = true;
    } else {
      heading.textContent = "Abertura diária pendente";
      description.textContent = "Confirme a presença da equipe. A fila não muda até essa confirmação.";
      button.textContent = "Confirmar presença";
      button.addEventListener("click", showOpeningDialog);
      const localHour = Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23"
      }).format(new Date()));
      if (localHour >= 8 && state.promptedOpeningDate !== localDate()) {
        state.promptedOpeningDate = localDate();
        showOpeningDialog();
      }
    }
    card.append(heading, description, button);
  }

  async function loadWaitingVehicles() {
    const list = $("#waiting-vehicles");
    const { data, error } = await client.from("vehicles")
      .select("id,model,entered_at")
      .eq("status", "waiting")
      .order("entered_at");
    if (error) throw error;
    list.replaceChildren();
    if (!data?.length) {
      const empty = document.createElement("p");
      empty.className = "empty-text";
      empty.textContent = "Nenhum veículo aguardando.";
      list.append(empty);
      return;
    }
    data.forEach((vehicle) => {
      const row = document.createElement("div");
      row.className = "waiting-row";
      const model = document.createElement("strong");
      model.textContent = vehicle.model;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Atribuir ${vehicle.model}`);
      select.append(new Option("Selecionar mecânico", ""));
      state.mechanics.forEach((mechanic) => select.append(new Option(mechanic.name, mechanic.id)));
      const button = document.createElement("button");
      button.className = "button button-outline button-small";
      button.type = "button";
      button.textContent = "Atribuir";
      button.addEventListener("click", async () => {
        if (!select.value) return showToast("Selecione um mecânico.", true);
        try {
          await callRpc("assign_waiting_vehicle", { p_mechanic_id: select.value, p_vehicle_id: vehicle.id }, "Veículo atribuído.");
        } catch (error) { showError(error, "Falha ao atribuir veículo"); }
      });
      row.append(model, select, button);
      list.append(row);
    });
  }

  function renderAdminData() {
    const container = $("#admin-mechanics");
    renderWithMovement(container, () => {
      container.replaceChildren();
      state.mechanics.forEach((mechanic, index) => {
        const row = document.createElement("div");
        row.className = "admin-mechanic-row";
        row.dataset.mechanicId = mechanic.id;
        const person = document.createElement("div");
        person.className = "admin-person";
        const position = document.createElement("span");
        position.className = "position";
        position.textContent = String(index + 1).padStart(2, "0");
        const name = document.createElement("strong");
        name.textContent = mechanic.name;
        person.append(position, name);

        const controls = document.createElement("div");
        controls.className = "admin-controls";
        const status = document.createElement("select");
        status.setAttribute("aria-label", `Status de ${mechanic.name}`);
        [["available", "Disponível"], ["maintenance", "Em manutenção"], ["pause", "Pausa"], ["absent", "Ausente"]]
          .forEach(([value, label]) => status.append(new Option(label, value)));
        status.value = mechanic.status;
        const model = document.createElement("input");
        model.maxLength = 100;
        model.placeholder = "Modelo do veículo";
        model.setAttribute("aria-label", `Veículo de ${mechanic.name}`);
        model.value = mechanic.vehicle_model || "";
        model.hidden = status.value !== "maintenance";

        const plate = document.createElement("input");
        plate.maxLength = 8;
        plate.placeholder = "Placa";
        plate.setAttribute("aria-label", `Placa de ${mechanic.name}`);
        plate.value = mechanic.vehicle_plate || "";
        plate.hidden = status.value !== "maintenance";
        plate.addEventListener("input", () => {
          plate.value = normalizePlate(plate.value);
        });

        status.addEventListener("change", () => {
          model.hidden = status.value !== "maintenance";
          plate.hidden = status.value !== "maintenance";
        });

        const save = document.createElement("button");
        save.className = "button button-primary button-small";
        save.type = "button";
        save.textContent = "Salvar";
        save.addEventListener("click", async () => {
          try {
            if (status.value === "maintenance") {
              if (!model.value.trim()) return showToast("Informe o modelo do veículo.", true);
              const normalizedPlate = normalizePlate(plate.value);
              if (!normalizedPlate) return showToast("Informe a placa do veículo.", true);
              if (mechanic.status === "maintenance" && mechanic.vehicle_model === model.value.trim() && mechanic.vehicle_plate === normalizedPlate) {
                return showToast(`${mechanic.name} já está em manutenção com ${model.value.trim()} | ${normalizedPlate}.`);
              }
              await callRpc("start_service", { p_mechanic_id: mechanic.id, p_model: model.value.trim(), p_plate: normalizedPlate }, `${mechanic.name} iniciou serviço: ${model.value.trim()} | ${normalizedPlate}.`);
            } else {
              await callRpc("set_mechanic_status", { p_mechanic_id: mechanic.id, p_status: status.value }, `Status de ${mechanic.name} atualizado.`);
            }
          } catch (error) {
            if (/Could not find the function public\.start_service|schema cache/i.test(error.message || "")) {
              showToast("O Supabase ainda não reconhece a função com placa. Execute fix-add-mechanic.sql no SQL Editor para atualizar o banco.", true);
            } else {
              showError(error, "Falha ao atualizar mecânico");
            }
          }
        });
        controls.append(status, model, plate, save);
        if (mechanic.status === "maintenance" && mechanic.vehicle_model) {
          const finish = document.createElement("button");
          finish.className = "button button-outline button-small";
          finish.type = "button";
          finish.textContent = "Finalizar serviço";
          finish.addEventListener("click", async () => {
            try { await callRpc("finish_service", { p_mechanic_id: mechanic.id }, `Serviço de ${mechanic.name} finalizado; mecânico movido ao fim da fila.`); }
            catch (error) { showError(error, "Falha ao finalizar serviço"); }
          });
          controls.append(finish);
        }
        const arrows = document.createElement("div");
        arrows.className = "queue-buttons";
        [["↑", index - 1, "Subir posição"], ["↓", index + 1, "Descer posição"]].forEach(([label, target, description]) => {
          const button = document.createElement("button");
          button.className = "icon-button";
          button.type = "button";
          button.textContent = label;
          button.setAttribute("aria-label", `${description} de ${mechanic.name}`);
          button.disabled = state.queueSaving || target < 0 || target >= state.mechanics.length;
          button.addEventListener("click", () => {
            const currentIndex = state.mechanics.findIndex((item) => item.id === mechanic.id);
            moveMechanic(currentIndex, currentIndex + (label === "↑" ? -1 : 1));
          });
          arrows.append(button);
        });
        row.append(person, controls, arrows);
        container.append(row);
      });
    });
  }

  function reorderAdminRows() {
    const container = $("#admin-mechanics");
    renderWithMovement(container, () => {
      const rows = new Map(
        [...container.children].map((row) => [row.dataset.mechanicId, row])
      );
      state.mechanics.forEach((mechanic, index) => {
        const row = rows.get(mechanic.id);
        if (!row) return;
        container.append(row);
        row.querySelector(".admin-person .position").textContent = String(index + 1).padStart(2, "0");
        row.querySelectorAll(".queue-buttons button").forEach((button, direction) => {
          const target = direction === 0 ? index - 1 : index + 1;
          button.disabled = state.queueSaving || target < 0 || target >= state.mechanics.length;
          button.setAttribute("aria-label", `${direction === 0 ? "Subir posição" : "Descer posição"} de ${mechanic.name}`);
        });
      });
    });
  }

  async function moveMechanic(from, to) {
    if (state.queueSaving || to < 0 || to >= state.mechanics.length) return;
    const previousOrder = [...state.mechanics];
    const reordered = [...state.mechanics];
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
    state.mechanics = reordered.map((mechanic, index) => ({ ...mechanic, queue_position: index + 1 }));
    state.queueSaving = true;
    renderBoard();
    reorderAdminRows();

    state.mutationInProgress = true;
    let shouldReload = false;
    try {
      const { error } = await client.rpc("reorder_mechanics", {
        p_mechanic_ids: reordered.map((item) => item.id)
      });
      if (error) throw error;
      showToast("Ordem da fila salva.");
    } catch (error) {
      state.mechanics = previousOrder;
      renderBoard();
      reorderAdminRows();
      shouldReload = true;
      showError(error, "Falha ao reorganizar fila");
    } finally {
      state.mutationInProgress = false;
      state.realtimeRefreshQueued = false;
      state.queueSaving = false;
      reorderAdminRows();
    }
    if (shouldReload) await refresh();
    else $("#updated-at").textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"
    }).format(new Date())}`;
  }


  $("#admin-toggle").addEventListener("click", () => {
    adminPanel.hidden = !adminPanel.hidden;
    if (!adminPanel.hidden) adminPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const fullscreenToggle = $("#fullscreen-toggle");
  function updateFullscreenButton() {
    const isFullscreen = Boolean(document.fullscreenElement);
    fullscreenToggle.setAttribute("aria-label", isFullscreen ? "Sair da tela cheia" : "Entrar em tela cheia");
    fullscreenToggle.title = isFullscreen ? "Sair da tela cheia" : "Entrar em tela cheia";
    $(".fullscreen-enter").hidden = isFullscreen;
    $(".fullscreen-exit").hidden = !isFullscreen;
  }
  fullscreenToggle.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else {
        throw new Error("Seu navegador não oferece suporte à tela cheia.");
      }
    } catch (error) {
      showError(error, "Não foi possível alterar a tela cheia");
    }
  });
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  updateFullscreenButton();

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const username = $("#login-username").value.trim().toLocaleLowerCase("pt-BR");
      if (!adminUsernames.has(username)) {
        throw new Error("Usuário não autorizado. Confira se digitou Caio, Gustavo, Fernando ou Victor.");
      }
      const { error } = await client.auth.signInWithPassword({
        email: authEmailForUsername(username), password: $("#login-password").value
      });
      if (error) throw error;
      await updateAuthView();
      if (state.admin) showToast("Acesso administrativo autorizado.");
    } catch (error) { showError(error, "Não foi possível entrar"); }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      state.admin = false;
      await updateAuthView();
      showToast("Sessão encerrada.");
    } catch (error) { showError(error, "Falha ao sair"); }
  });

  $("#vehicle-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = $("#vehicle-model").value.trim();
    const mechanicId = $("#vehicle-mechanic").value;
    try {
      if (mechanicId) {
        await callRpc("start_service", { p_mechanic_id: mechanicId, p_model: model }, `Entrada registrada e serviço iniciado: ${model}.`);
      } else {
        await callRpc("register_vehicle", { p_model: model }, `Entrada do veículo ${model} registrada.`);
      }
      $("#vehicle-model").value = "";
      $("#vehicle-mechanic").value = "";
    } catch (error) { showError(error, "Falha ao registrar veículo"); }
  });

  $("#mechanic-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#mechanic-name");
    const name = input.value.trim();
    if (!name) return;
    try {
      await callRpc("add_mechanic", { p_name: name }, `${name} adicionado à equipe.`);
      input.value = "";
    } catch (error) { showError(error, "Falha ao adicionar mecânico"); }
  });

  $("#opening-form").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "confirm") return;
    event.preventDefault();
    const attendance = [...$("#attendance-fields").querySelectorAll("select")].map((select) => ({
      mechanic_id: select.dataset.mechanicId, attendance: select.value
    }));
    try {
      await callRpc("open_workday", { p_attendance: attendance }, "Abertura confirmada; fila atualizada.");
      $("#opening-dialog").close();
    } catch (error) { showError(error, "Falha ao confirmar abertura"); }
  });

  async function start() {
    if (!configReady || !client) {
      loading.hidden = true;
      notice.hidden = false;
      $("#admin-toggle").hidden = true;
      notice.textContent = "O sistema ainda não está conectado ao Supabase. Configure supabase-config.js e execute supabase-schema.sql conforme o README.";
      $("#connection-label").textContent = "Configuração necessária";
      return;
    }
    try {
      await refresh();
      startClock();
      connectRealtime();
      await updateAuthView();
      state.businessDate = localDate();
      window.setInterval(() => {
        const today = localDate();
        if (today !== state.businessDate) {
          state.businessDate = today;
          loadCounts().catch((e) => showError(e, "Falha ao atualizar contadores"));
          if (state.admin) loadOpeningState().catch((e) => showError(e, "Falha ao conferir abertura diária"));
        }
      }, 30_000);
      client.auth.onAuthStateChange(() => {
        window.setTimeout(() => updateAuthView().catch((e) => showError(e, "Falha ao verificar acesso")), 0);
      });
    } catch (error) {
      loading.hidden = true;
      showError(error, "Não foi possível carregar o sistema");
      notice.hidden = false;
      notice.textContent = "Verifique a configuração do Supabase e confirme que o esquema do banco de dados foi instalado.";
    }
  }

  start();
})();
