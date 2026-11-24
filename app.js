(function () {
  "use strict";

  var DEFAULT_BUDGET = { dailyAllowance: 10000, weeklyArisan: 25000, dailyFree: 0, weekdays: [1, 2, 3, 4, 5] };
  var PAGE_TEXT = {
    dashboard: ["Dashboard", "Hai, selamat datang! 👋", "Lihat saldo dan kondisi keuanganmu secara menyeluruh."],
    transactions: ["Uang masuk & keluar", "Catat uangmu dengan mudah", "Tambahkan pemasukan atau pengeluaran dan lihat saran alokasinya."],
    targets: ["Target & kewajiban", "Rencanakan tujuanmu 🎯", "Pantau pembayaran utang, kewajiban, dan progres tabungan."],
    budget: ["Anggaran & jadwal", "Atur uang jajanmu", "Susun anggaran harian, jadwal kuliah, dan kewajiban mingguan."],
    checklist: ["Checklist mingguan", "Pantau rutinitas keuanganmu", "Centang arisan, uang jajan, pembayaran utang, dan target tabungan per hari."],
    history: ["Riwayat transaksi", "Semua catatan dalam satu tempat", "Telusuri kembali seluruh pemasukan dan pengeluaranmu."]
  };
  var state;
  var pendingSession;
  var currentPage = "dashboard";
  var toastTimer;
  var budgetSaveTimer;
  var saveQueue = Promise.resolve();
  var rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
  var dayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  var monthNow = localMonthKey(new Date());

  function localDateKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function localMonthKey(date) { return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0"); }
  function weekKey(date) {
    var monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return localDateKey(monday);
  }
  function defaultState() {
    return {
      transactions: [],
      targets: [{ id: "arisan", name: "Arisan mingguan", goal: 25000, saved: 0, kind: "arisan" }],
      allowanceDays: [],
      weeklyChecks: {},
      arisanWeek: weekKey(new Date()),
      budget: { dailyAllowance: DEFAULT_BUDGET.dailyAllowance, weeklyArisan: DEFAULT_BUDGET.weeklyArisan, dailyFree: DEFAULT_BUDGET.dailyFree, weekdays: DEFAULT_BUDGET.weekdays.slice() },
      obligations: [{ id: "obligation-arisan", name: "Setoran arisan", amount: 25000, day: 5, targetId: "arisan" }]
    };
  }
  function nonNegativeValue(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }
  function normalizeState(saved) {
    var fresh = defaultState();
    if (!saved || typeof saved !== "object") return fresh;
    var targets = Array.isArray(saved.targets) ? saved.targets.map(function (target) {
      return {
        id: String(target.id || makeId()),
        name: String(target.name || "Target baru"),
        goal: Math.max(0, Number(target.goal) || 0),
        saved: Math.max(0, Number(target.saved) || 0),
        kind: target.kind === "arisan" ? "arisan" : (target.kind === "debt" || target.kind === "bill" ? target.kind : "savings")
      };
    }) : fresh.targets;
    if (!targets.some(function (target) { return target.kind === "arisan"; })) targets.unshift(fresh.targets[0]);
    var budget = saved.budget && typeof saved.budget === "object" ? saved.budget : {};
    var parsedWeekdays = Array.isArray(budget.weekdays) ? budget.weekdays.map(Number).filter(function (day) { return day >= 0 && day <= 6; }) : fresh.budget.weekdays.slice();
    var oldDailyDefault = Number(budget.dailyAllowance) === 50000 &&
      Number(budget.weeklyArisan) === 25000 &&
      Number(budget.dailyFree) === 25000 &&
      parsedWeekdays.length === 5 &&
      [1, 2, 3, 4, 5].every(function (day) { return parsedWeekdays.indexOf(day) >= 0; });
    var normalized = {
      transactions: Array.isArray(saved.transactions) ? saved.transactions.filter(function (item) { return item && (item.type === "income" || item.type === "expense"); }).map(function (item) {
        return {
          id: String(item.id || makeId()),
          type: item.type,
          amount: Math.max(0, Number(item.amount) || 0),
          category: String(item.category || "Lainnya"),
          description: String(item.description || item.category || "Transaksi"),
          date: /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") ? item.date : localDateKey(new Date()),
          createdAt: item.createdAt || (item.date || localDateKey(new Date())) + "T12:00:00",
          targetId: item.targetId ? String(item.targetId) : "",
          sourceId: item.sourceId ? String(item.sourceId) : "",
          allowanceAllocated: Boolean(item.allowanceAllocated),
          isAuto: Boolean(item.isAuto)
        };
      }) : [],
      targets: targets,
      allowanceDays: Array.isArray(saved.allowanceDays) ? saved.allowanceDays.filter(function (date) { return /^\d{4}-\d{2}-\d{2}$/.test(date); }) : [],
      weeklyChecks: saved.weeklyChecks && typeof saved.weeklyChecks === "object" ? Object.keys(saved.weeklyChecks).reduce(function (checks, date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !saved.weeklyChecks[date] || typeof saved.weeklyChecks[date] !== "object") return checks;
        checks[date] = {};
        ["allowance", "debt", "savings"].forEach(function (kind) {
          if (typeof saved.weeklyChecks[date][kind] === "boolean") checks[date][kind] = saved.weeklyChecks[date][kind];
        });
        return checks;
      }, {}) : {},
      arisanWeek: typeof saved.arisanWeek === "string" ? saved.arisanWeek : "",
      budget: {
        dailyAllowance: oldDailyDefault ? fresh.budget.dailyAllowance : nonNegativeValue(budget.dailyAllowance, fresh.budget.dailyAllowance),
        weeklyArisan: nonNegativeValue(budget.weeklyArisan, fresh.budget.weeklyArisan),
        dailyFree: oldDailyDefault ? fresh.budget.dailyFree : nonNegativeValue(budget.dailyFree, fresh.budget.dailyFree),
        weekdays: Array.isArray(budget.weekdays) ? Array.from(new Set(parsedWeekdays)) : fresh.budget.weekdays.slice()
      },
      obligations: Array.isArray(saved.obligations) ? saved.obligations.map(function (item) {
        return { id: String(item.id || makeId()), name: String(item.name || "Kewajiban"), amount: Math.max(0, Number(item.amount) || 0), day: Number(item.day) >= 0 && Number(item.day) <= 6 ? Number(item.day) : 5, targetId: item.targetId ? String(item.targetId) : "" };
      }) : fresh.obligations
    };
    if (!normalized.obligations.some(function (item) { return item.targetId === "arisan"; })) {
      normalized.obligations.unshift({ id: "obligation-arisan", name: "Setoran arisan", amount: normalized.budget.weeklyArisan, day: 5, targetId: "arisan" });
    }
    return normalized;
  }
  function makeId() { return String(Date.now()) + Math.random().toString(36).slice(2, 8); }
  function money(amount) { return rupiah.format(Number(amount) || 0); }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }
  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2800);
  }
  function setSaveStatus(status, message) {
    var indicator = document.getElementById("saveStatus");
    indicator.className = "save-status " + status;
    document.getElementById("saveStatusText").textContent = message;
  }
  function persistState() {
    setSaveStatus("", "Menyimpan perubahan…");
    var snapshot = JSON.parse(JSON.stringify(state));
    saveQueue = saveQueue.catch(function () {}).then(function () { return window.MyMoneyDB.saveState(snapshot); });
    return saveQueue.then(function () {
      setSaveStatus("saved", "Tersimpan di Supabase");
      return true;
    }).catch(function (error) {
      console.error("Perubahan MyMoney gagal disimpan.", error);
      setSaveStatus("error", "Gagal menyimpan");
      showToast("Perubahan belum tersimpan ke database. " + error.message);
      return false;
    });
  }
  function totals(items) {
    return items.reduce(function (result, item) {
      result[item.type] += Number(item.amount) || 0;
      if (item.date && item.date.slice(0, 7) === monthNow) result["month" + item.type] += Number(item.amount) || 0;
      return result;
    }, { income: 0, expense: 0, monthincome: 0, monthexpense: 0 });
  }
  function arisanTarget() { return state.targets.find(function (target) { return target.kind === "arisan"; }); }
  function scheduledWeekdays() { return state.budget.weekdays.slice().sort(function (a, b) { return ((a + 6) % 7) - ((b + 6) % 7); }); }
  function dailyArisanAllocation() {
    var days = state.budget.weekdays.length;
    return days ? Math.ceil(state.budget.weeklyArisan / days) : 0;
  }
  function updateToday() {
    var now = new Date();
    var formatted = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
    document.getElementById("todayLabel").textContent = formatted;
    document.getElementById("entryDate").textContent = formatted;
    monthNow = localMonthKey(now);
  }
  function showPage(pageName) {
    if (!PAGE_TEXT[pageName]) return;
    currentPage = pageName;
    document.querySelectorAll(".page").forEach(function (page) {
      var isActive = page.id === "page-" + pageName;
      page.classList.toggle("active", isActive);
      page.hidden = !isActive;
    });
    document.querySelectorAll(".nav-item").forEach(function (item) { item.classList.toggle("active", item.dataset.page === pageName); });
    document.getElementById("pageTitle").textContent = PAGE_TEXT[pageName][0];
    document.getElementById("pageHeading").textContent = PAGE_TEXT[pageName][1];
    document.getElementById("pageDescription").textContent = PAGE_TEXT[pageName][2];
    if (pageName === "budget") renderBudget();
    if (pageName === "transactions") renderTransactionAdvice();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function render() {
    updateToday();
    renderDashboard();
    renderTargets();
    renderTransactionHistory();
    renderBudget();
    renderChecklist();
    updateTransactionForm();
    renderTransactionAdvice();
  }
  function renderDashboard() {
    var summary = totals(state.transactions);
    var balance = summary.income - summary.expense;
    document.getElementById("balance").textContent = money(balance);
    document.getElementById("incomeTotal").textContent = money(summary.income);
    document.getElementById("expenseTotal").textContent = money(summary.expense);
    document.getElementById("monthIncome").textContent = money(summary.monthincome);
    document.getElementById("monthExpense").textContent = money(summary.monthexpense);

    var badge = document.getElementById("conditionBadge");
    var copy;
    badge.className = "condition-badge";
    if (!state.transactions.length) {
      badge.textContent = "Belum ada data";
      copy = "Catat pemasukan dan pengeluaran pertamamu untuk melihat kondisi keuangan serta rekomendasi yang lebih sesuai.";
    } else if (balance < 0) {
      badge.classList.add("danger");
      badge.textContent = "Perlu perhatian";
      copy = "Pengeluaran tercatat lebih besar daripada pemasukan. Tinjau transaksi dan prioritaskan kebutuhan yang paling penting.";
    } else if (balance < state.budget.dailyFree) {
      badge.classList.add("warning");
      badge.textContent = "Jaga pengeluaran";
      copy = "Saldo tersisa kurang dari anggaran bebas harian (" + money(state.budget.dailyFree) + "). Periksa anggaran sebelum belanja.";
    } else {
      badge.textContent = "Cukup terkendali";
      copy = "Saldo masih dapat menutup lebih dari satu hari uang jajan sesuai anggaran. Tetap sisihkan untuk target dan kewajiban.";
    }
    document.getElementById("conditionCopy").textContent = copy;

    var arisan = arisanTarget();
    var arisanRemaining = arisan ? Math.max(0, arisan.goal - arisan.saved) : 0;
    var numberOfDays = state.budget.weekdays.length || 1;
    var needed = Math.ceil(arisanRemaining / numberOfDays);
    document.getElementById("dashboardAdvice").innerHTML = arisanRemaining > 0
      ? "Target arisan minggu ini masih kurang <strong>" + money(arisanRemaining) + "</strong>. Sisihkan sekitar <strong>" + money(Math.min(needed, dailyArisanAllocation())) + "</strong> pada setiap hari kuliah yang dijadwalkan."
      : "Target arisan minggu ini sudah terpenuhi. Pertimbangkan alihkan sisa anggaran ke <strong>tabungan atau pembayaran utang</strong>.";
    renderTargetList(document.getElementById("dashboardTargets"), true);
  }
  function targetTypeLabel(target) {
    if (target.kind === "arisan") return "Kewajiban mingguan";
    if (target.kind === "debt") return "Pembayaran utang";
    if (target.kind === "bill") return "Kewajiban";
    return "Tabungan";
  }
  function renderTargetList(container, compact) {
    if (!state.targets.length) {
      container.innerHTML = '<div class="empty">Belum ada target. Buat target tabungan atau pembayaran utang.</div>';
      return;
    }
    var targets = compact ? state.targets.slice(0, 4) : state.targets;
    container.innerHTML = targets.map(function (target) {
      var progress = target.goal > 0 ? Math.min(100, Math.round(target.saved / target.goal * 100)) : 0;
      var remaining = Math.max(0, target.goal - target.saved);
      var isArisan = target.kind === "arisan";
      return '<article class="target-item' + (compact ? " compact-item" : "") + '">' +
        '<div class="target-top"><span><span class="target-name">' + escapeHtml(target.name) + '</span><span class="target-kind">' + targetTypeLabel(target) + '</span></span><span class="target-amount">' + money(target.saved) + ' / ' + money(target.goal) + '</span></div>' +
        '<div class="progress' + (isArisan ? " orange" : "") + '"><span style="width:' + progress + '%"></span></div>' +
        '<div class="target-foot"><span>' + (isArisan ? "Kurang " + money(remaining) + " minggu ini" : "Sisa " + money(remaining)) + '</span>' +
        (compact ? "<span>" + progress + "%</span>" : '<button class="btn" type="button" data-contribute="' + escapeHtml(target.id) + '">Setor / bayar</button>') +
        '</div></article>';
    }).join("");
  }
  function renderTargets() { renderTargetList(document.getElementById("targetList"), false); }
  function formatDate(dateString) {
    var date = new Date(dateString + "T12:00:00");
    return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(date);
  }
  function transactionMarkup(item) {
    var isIncome = item.type === "income";
    var label = item.isAuto ? "Setoran otomatis: " + item.description : item.description;
    return '<div class="transaction"><div class="transaction-icon' + (isIncome ? "" : " out") + '">' + (isIncome ? "↙" : "↗") + '</div>' +
      '<div><div class="transaction-name">' + escapeHtml(label) + '</div><div class="transaction-meta">' + escapeHtml(item.category) + ' · ' + formatDate(item.date) + '</div></div>' +
      '<div class="transaction-amount ' + (isIncome ? "in" : "out") + '">' + (isIncome ? "+" : "−") + money(item.amount) +
      '<button class="delete-transaction" type="button" data-delete="' + escapeHtml(item.id) + '" aria-label="Hapus transaksi ' + escapeHtml(item.description) + '">Hapus</button></div></div>';
  }
  function sortedTransactions() {
    return state.transactions.slice().sort(function (a, b) { return (b.createdAt || b.date).localeCompare(a.createdAt || a.date); });
  }
  function renderTransactionHistory() {
    var recent = sortedTransactions().slice(0, 5);
    document.getElementById("recentTransactions").innerHTML = recent.length
      ? recent.map(transactionMarkup).join("")
      : '<div class="empty">Belum ada transaksi. Catat uang masuk atau uang keluar untuk mulai.</div>';

    var filter = document.getElementById("historyFilter").value;
    var month = document.getElementById("monthFilter").value;
    var history = sortedTransactions().filter(function (item) {
      return (filter === "all" || item.type === filter) && (!month || item.date.slice(0, 7) === month);
    });
    var summary = totals(history);
    document.getElementById("historyIncome").textContent = money(summary.income);
    document.getElementById("historyExpense").textContent = money(summary.expense);
    document.getElementById("historyNet").textContent = money(summary.income - summary.expense);
    document.getElementById("historyList").innerHTML = history.length
      ? history.map(transactionMarkup).join("")
      : '<div class="empty">Tidak ada transaksi yang cocok dengan filter pilihanmu.</div>';
  }
  function refreshCategories(type) {
    var category = document.getElementById("category");
    var values = type === "income"
      ? ["Uang jajan kampus", "Tambahan / hadiah", "Gaji / usaha", "Lainnya"]
      : ["Makan & minum", "Transportasi", "Belanja", "Arisan", "Bayar utang", "Tabungan", "Lainnya"];
    var previous = category.value;
    category.innerHTML = values.map(function (value) { return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + "</option>"; }).join("");
    if (values.indexOf(previous) >= 0) category.value = previous;
    else category.value = type === "income" ? "Uang jajan kampus" : "Makan & minum";
    var targetSelect = document.getElementById("targetSelect");
    targetSelect.innerHTML = '<option value="">Tidak ada target</option>' + state.targets.map(function (target) {
      return '<option value="' + escapeHtml(target.id) + '">' + escapeHtml(target.name) + "</option>";
    }).join("");
  }
  function setTransactionType(type, preset) {
    document.getElementById("transactionType").value = type;
    document.querySelectorAll(".type-tab").forEach(function (tab) { tab.classList.toggle("active", tab.dataset.type === type); });
    document.getElementById("targetField").hidden = type !== "expense";
    document.getElementById("allocationField").hidden = type !== "income";
    refreshCategories(type);
    if (preset) {
      document.getElementById("amount").value = type === "income" ? String(state.budget.dailyAllowance) : "";
      document.getElementById("description").value = type === "income" ? "Uang jajan kampus" : "";
      if (type === "income") document.getElementById("category").value = "Uang jajan kampus";
      else document.getElementById("category").value = "Makan & minum";
      document.getElementById("autoAllocate").checked = true;
      document.getElementById("targetSelect").value = "";
    }
    renderTransactionAdvice();
  }
  function updateTransactionForm() {
    var type = document.getElementById("transactionType").value || "income";
    refreshCategories(type);
    document.getElementById("targetField").hidden = type !== "expense";
    document.getElementById("allocationField").hidden = type !== "income";
  }
  function renderTransactionAdvice() {
    if (!state) return;
    var type = document.getElementById("transactionType").value || "income";
    var amount = Math.max(0, Number(document.getElementById("amount").value) || (type === "income" ? state.budget.dailyAllowance : 0));
    var category = document.getElementById("category").value;
    var target = state.targets.find(function (item) { return item.id === document.getElementById("targetSelect").value; });
    var lines = "";
    if (type === "income" && category === "Uang jajan kampus") {
      var now = new Date();
      var arisan = arisanTarget();
      var canAllocateArisan = state.budget.weekdays.indexOf(now.getDay()) >= 0 &&
        state.allowanceDays.indexOf(localDateKey(now)) < 0 && arisan;
      var remainingArisan = canAllocateArisan ? Math.max(0, arisan.goal - arisan.saved) : 0;
      var setAside = document.getElementById("autoAllocate").checked
        ? Math.min(amount, dailyArisanAllocation(), remainingArisan)
        : 0;
      var freeLimit = Math.min(state.budget.dailyFree, Math.max(0, amount - setAside));
      var other = Math.max(0, amount - setAside - freeLimit);
      lines = allocationLine("Uang jajan dicatat", money(amount)) +
        allocationLine("Arisan mingguan", "− " + money(setAside)) +
        allocationLine("Belanja bebas hari ini", money(freeLimit)) +
        allocationLine("Sisa untuk target / kebutuhan", money(other), true);
      document.getElementById("transactionAdvice").innerHTML = "Pengaturan saat ini menyisihkan <strong>" + money(setAside) + "</strong> untuk arisan. Kamu bisa mengubah alokasi harian dan hari kuliah di menu Anggaran & jadwal.";
    } else if (type === "income") {
      lines = allocationLine("Pemasukan tambahan", money(amount)) + allocationLine("Belanja bebas per hari (opsional)", money(state.budget.dailyFree)) +
        allocationLine("Sisa tersedia sebelum target", money(amount), true);
      document.getElementById("transactionAdvice").textContent = "Pemasukan tambahan seperti hadiah dapat diarahkan ke target tabungan atau pembayaran yang paling penting.";
    } else {
      var balance = totals(state.transactions).income - totals(state.transactions).expense;
      lines = allocationLine("Saldo saat ini", money(balance)) + allocationLine("Transaksi yang akan dicatat", "− " + money(amount)) +
        allocationLine("Saldo setelah transaksi", money(balance - amount), true);
      document.getElementById("transactionAdvice").textContent = target
        ? "Pembayaran ini akan menambah progres target “" + target.name + "” sebesar " + money(amount) + "."
        : "Sebelum menyimpan, pastikan pengeluaran ini sesuai kebutuhan dan tidak mengganggu kewajiban mingguan.";
    }
    document.getElementById("allocationBreakdown").innerHTML = lines;
  }
  function allocationLine(label, value, highlight) {
    return '<div class="allocation-line' + (highlight ? " highlight" : "") + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + "</strong></div>";
  }
  function renderBudget() {
    if (!state) return;
    var fields = {
      dailyAllowance: document.getElementById("dailyAllowance"),
      weeklyArisan: document.getElementById("weeklyArisan"),
      dailyFree: document.getElementById("dailyFree")
    };
    if (document.activeElement !== fields.dailyAllowance) fields.dailyAllowance.value = state.budget.dailyAllowance;
    if (document.activeElement !== fields.weeklyArisan) fields.weeklyArisan.value = state.budget.weeklyArisan;
    if (document.activeElement !== fields.dailyFree) fields.dailyFree.value = state.budget.dailyFree;
    document.querySelectorAll('input[name="weekday"]').forEach(function (input) { input.checked = state.budget.weekdays.indexOf(Number(input.value)) >= 0; });

    var weekdayCount = state.budget.weekdays.length;
    var reserved = dailyArisanAllocation();
    var remainder = Math.max(0, state.budget.dailyAllowance - reserved - state.budget.dailyFree);
    document.getElementById("budgetBreakdown").innerHTML =
      allocationLine("Total uang jajan per minggu (" + weekdayCount + " hari)", money(state.budget.dailyAllowance * weekdayCount)) +
      allocationLine("Uang jajan per hari", money(state.budget.dailyAllowance)) +
      allocationLine("Arisan per hari kuliah (" + (weekdayCount ? weekdayCount + " hari" : "belum dijadwalkan") + ")", "− " + money(reserved)) +
      allocationLine("Belanja bebas per hari", "− " + money(state.budget.dailyFree)) +
      allocationLine("Sisa untuk target / kebutuhan", money(remainder), true);

    var days = scheduledWeekdays();
    var today = new Date();
    var thisWeek = weekKey(today);
    var monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    document.getElementById("weeklySchedule").innerHTML = days.length ? days.map(function (day) {
      var date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
      date.setDate(date.getDate() + ((day + 6) % 7));
      var dateText = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date);
      var allowanceDate = localDateKey(date);
      var completed = state.allowanceDays.indexOf(allowanceDate) >= 0 && weekKey(date) === thisWeek;
      return '<div class="schedule-day"><span class="schedule-name">' + dayNames[day] + " · " + dateText + '</span><span class="schedule-detail">' + money(state.budget.dailyAllowance) + " · arisan " + money(reserved) + '</span><span class="schedule-state' + (completed ? "" : " pending") + '">' + (completed ? "Sudah disisihkan" : "Terjadwal") + "</span></div>";
    }).join("") : '<div class="empty">Pilih setidaknya satu hari untuk menjadwalkan uang jajan.</div>';
    renderObligations();
  }
  function isChecklistChecked(date, kind, recorded) {
    var checks = state.weeklyChecks[date];
    return checks && Object.prototype.hasOwnProperty.call(checks, kind) ? checks[kind] : recorded;
  }
  function renderChecklist() {
    var body = document.getElementById("weeklyChecklistBody");
    if (!body) return;
    var today = new Date();
    var monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    var sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
    sunday.setDate(sunday.getDate() + 6);
    var dateFormat = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" });
    document.getElementById("checklistWeek").textContent = dateFormat.format(monday) + " – " + dateFormat.format(sunday);
    var days = scheduledWeekdays();
    if (!days.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty">Atur jadwal uang jajan terlebih dahulu pada menu Anggaran & jadwal.</div></td></tr>';
      return;
    }
    var debtIds = state.targets.filter(function (target) { return target.kind === "debt"; }).map(function (target) { return target.id; });
    var savingsIds = state.targets.filter(function (target) { return target.kind === "savings"; }).map(function (target) { return target.id; });
    body.innerHTML = days.map(function (day) {
      var date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
      date.setDate(date.getDate() + ((day + 6) % 7));
      var dateKey = localDateKey(date);
      var dayTransactions = state.transactions.filter(function (item) { return item.date === dateKey; });
      var arisanDone = state.allowanceDays.indexOf(dateKey) >= 0;
      var allowanceDone = dayTransactions.some(function (item) { return item.type === "income" && item.category === "Uang jajan kampus"; });
      var debtDone = dayTransactions.some(function (item) { return item.type === "expense" && (item.category === "Bayar utang" || debtIds.indexOf(item.targetId) >= 0); });
      var savingsDone = dayTransactions.some(function (item) { return item.type === "expense" && (item.category === "Tabungan" || savingsIds.indexOf(item.targetId) >= 0); });
      var kinds = [
        { key: "arisan", label: "Arisan", checked: isChecklistChecked(dateKey, "arisan", arisanDone) },
        { key: "allowance", label: "Uang jajan", checked: isChecklistChecked(dateKey, "allowance", allowanceDone) },
        { key: "debt", label: "Pinjaman atau utang", checked: isChecklistChecked(dateKey, "debt", debtDone) },
        { key: "savings", label: "Target nabung", checked: isChecklistChecked(dateKey, "savings", savingsDone) }
      ];
      return '<tr><td><span class="checklist-day">' + dayNames[day] + '<small>' + dateFormat.format(date) + '</small></span></td>' +
        kinds.map(function (entry) {
          return '<td><input class="table-check" type="checkbox" data-check-kind="' + entry.key + '" data-check-date="' + dateKey + '" aria-label="' + entry.label + " hari " + dayNames[day] + '" ' + (entry.checked ? "checked" : "") + '></td>';
        }).join("") + '</tr>';
    }).join("");
  }
  async function toggleChecklistItem(date, kind, checked) {
    if (kind === "arisan") {
      await toggleScheduledSaving(date, checked);
      return;
    }
    if (!state.weeklyChecks[date]) state.weeklyChecks[date] = {};
    state.weeklyChecks[date][kind] = checked;
    var stored = await persistState();
    renderChecklist();
    if (stored) showToast(checked ? "Aktivitas ditandai selesai." : "Tanda aktivitas dihapus.");
  }
  function renderObligations() {
    var list = document.getElementById("obligationList");
    if (!state.obligations.length) {
      list.innerHTML = '<div class="empty">Belum ada kewajiban mingguan.</div>';
      return;
    }
    list.innerHTML = state.obligations.map(function (item) {
      return '<div class="obligation-row"><div><div class="obligation-name">' + escapeHtml(item.name) + '</div><div class="obligation-meta">Jatuh tempo setiap ' + dayNames[item.day] + (item.targetId ? " · Terhubung ke target" : "") + '</div></div><div class="obligation-amount">' + money(item.amount) + '</div>' +
        (item.targetId === "arisan" ? '<span class="condition-badge">Rutin</span>' : '<button class="icon-button" type="button" data-delete-obligation="' + escapeHtml(item.id) + '">Hapus</button>') + '</div>';
    }).join("");
  }
  function updateBudgetFromForm() {
    var allowance = Number(document.getElementById("dailyAllowance").value);
    var arisanValue = Number(document.getElementById("weeklyArisan").value);
    var freeValue = Number(document.getElementById("dailyFree").value);
    if (![allowance, arisanValue, freeValue].every(function (value) { return Number.isFinite(value) && value >= 0; })) return;
    state.budget.dailyAllowance = Math.round(allowance);
    state.budget.weeklyArisan = Math.round(arisanValue);
    state.budget.dailyFree = Math.round(freeValue);
    state.budget.weekdays = Array.from(document.querySelectorAll('input[name="weekday"]:checked')).map(function (input) { return Number(input.value); });
    var arisan = arisanTarget();
    if (arisan) {
      arisan.goal = state.budget.weeklyArisan;
      arisan.saved = Math.min(arisan.saved, arisan.goal);
    }
    var obligation = state.obligations.find(function (item) { return item.targetId === "arisan"; });
    if (obligation) obligation.amount = state.budget.weeklyArisan;
    renderBudget();
    renderDashboard();
    renderTransactionAdvice();
    clearTimeout(budgetSaveTimer);
    budgetSaveTimer = setTimeout(function () { persistState(); }, 350);
  }
  function setTransactionTypeAndGo(type, targetId) {
    showPage("transactions");
    setTransactionType(type, true);
    if (targetId) {
      var selectedTarget = state.targets.find(function (item) { return item.id === targetId; });
      document.getElementById("targetSelect").value = targetId;
      document.getElementById("description").value = "Setoran / pembayaran target";
      document.getElementById("category").value = categoryForTarget(selectedTarget);
      renderTransactionAdvice();
    }
  }
  function categoryForTarget(target) {
    if (!target) return "Lainnya";
    if (target.kind === "debt") return "Bayar utang";
    if (target.kind === "arisan") return "Arisan";
    if (target.kind === "savings") return "Tabungan";
    return "Lainnya";
  }
  async function submitTransaction(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var now = new Date();
    var type = document.getElementById("transactionType").value;
    var amount = Math.round(Number(document.getElementById("amount").value));
    var description = document.getElementById("description").value.trim();
    var category = document.getElementById("category").value;
    if (!Number.isFinite(amount) || amount <= 0 || !description) {
      showToast("Masukkan jumlah dan keterangan transaksi yang valid.");
      return;
    }
    var transaction = {
      id: makeId(),
      type: type,
      amount: amount,
      category: category,
      description: description,
      date: localDateKey(now),
      createdAt: now.toISOString(),
      targetId: "",
      allowanceAllocated: false
    };
    state.transactions.push(transaction);

    var infoMessage = type === "income" ? "Uang masuk berhasil dicatat." : "Uang keluar berhasil dicatat.";
    if (type === "income" && category === "Uang jajan kampus" && document.getElementById("autoAllocate").checked) {
      var day = now.getDay();
      var arisan = arisanTarget();
      var weeklyDays = state.budget.weekdays;
      if (arisan && weeklyDays.indexOf(day) >= 0 && state.allowanceDays.indexOf(transaction.date) < 0) {
        var amountToSetAside = Math.min(amount, dailyArisanAllocation(), Math.max(0, arisan.goal - arisan.saved));
        if (amountToSetAside > 0) {
          arisan.saved += amountToSetAside;
          transaction.allowanceAllocated = true;
          var allocation = {
            id: makeId(),
            type: "expense",
            amount: amountToSetAside,
            category: "Alokasi arisan",
            description: "Setoran arisan mingguan",
            date: transaction.date,
            createdAt: new Date(now.getTime() + 1).toISOString(),
            targetId: arisan.id,
            sourceId: transaction.id,
            isAuto: true
          };
          state.transactions.push(allocation);
          state.allowanceDays.push(transaction.date);
          infoMessage += " " + money(amountToSetAside) + " otomatis dialokasikan ke arisan.";
        }
      }
    }
    if (type === "income" && category === "Uang jajan kampus" && state.weeklyChecks[transaction.date]) {
      delete state.weeklyChecks[transaction.date].allowance;
    }
    if (type === "expense") {
      var targetId = document.getElementById("targetSelect").value;
      var selectedTarget = state.targets.find(function (target) { return target.id === targetId; });
      if (selectedTarget) {
        selectedTarget.saved = Math.min(selectedTarget.goal, selectedTarget.saved + amount);
        transaction.targetId = selectedTarget.id;
        infoMessage += " Progres target diperbarui.";
      }
      var checkKind = selectedTarget && selectedTarget.kind === "debt" ? "debt" :
        (selectedTarget && selectedTarget.kind === "savings" ? "savings" :
          (category === "Bayar utang" ? "debt" : (category === "Tabungan" ? "savings" : "")));
      if (checkKind && state.weeklyChecks[transaction.date]) delete state.weeklyChecks[transaction.date][checkKind];
    }
    var stored = await persistState();
    form.reset();
    setTransactionType("income", true);
    render();
    if (!stored) return;
    showToast(infoMessage);
  }
  async function submitTarget(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var name = document.getElementById("targetName").value.trim();
    var goal = Math.round(Number(document.getElementById("targetAmount").value));
    if (!name || !Number.isFinite(goal) || goal <= 0) { showToast("Masukkan nama dan jumlah target yang valid."); return; }
    state.targets.push({ id: makeId(), name: name, goal: goal, saved: 0, kind: document.getElementById("targetKind").value });
    var stored = await persistState();
    if (!stored) return;
    form.reset();
    render();
    showToast("Target baru berhasil disimpan.");
  }
  async function submitObligation(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var name = document.getElementById("obligationName").value.trim();
    var amount = Math.round(Number(document.getElementById("obligationAmount").value));
    if (!name || !Number.isFinite(amount) || amount <= 0) { showToast("Lengkapi nama dan jumlah kewajiban."); return; }
    state.obligations.push({ id: makeId(), name: name, amount: amount, day: Number(document.getElementById("obligationDay").value), targetId: "" });
    var stored = await persistState();
    if (!stored) return;
    form.reset();
    renderBudget();
    showToast("Kewajiban mingguan berhasil ditambahkan.");
  }
  function decrementTargetProgress(transaction) {
    if (transaction.targetId) {
      var target = state.targets.find(function (item) { return item.id === transaction.targetId; });
      if (target) target.saved = Math.max(0, target.saved - transaction.amount);
    }
  }
  async function deleteTransaction(id) {
    var item = state.transactions.find(function (transaction) { return transaction.id === id; });
    if (!item || !window.confirm("Hapus transaksi ini?")) return;
    var removeIds = [item.id];
    if (item.type === "income" && item.allowanceAllocated) {
      var allocation = state.transactions.find(function (transaction) { return transaction.sourceId === item.id; });
      if (allocation) {
        removeIds.push(allocation.id);
        decrementTargetProgress(allocation);
      }
      state.allowanceDays = state.allowanceDays.filter(function (date) { return date !== item.date; });
    } else if (item.sourceId) {
      decrementTargetProgress(item);
      state.allowanceDays = state.allowanceDays.filter(function (date) { return date !== item.date; });
      var source = state.transactions.find(function (transaction) { return transaction.id === item.sourceId; });
      if (source) source.allowanceAllocated = false;
    } else if (item.category === "Alokasi arisan") {
      decrementTargetProgress(item);
      state.allowanceDays = state.allowanceDays.filter(function (date) { return date !== item.date; });
    } else {
      decrementTargetProgress(item);
    }
    state.transactions = state.transactions.filter(function (transaction) { return removeIds.indexOf(transaction.id) < 0; });
    var stored = await persistState();
    render();
    if (!stored) return;
    showToast("Transaksi berhasil dihapus.");
  }
  async function deleteObligation(id) {
    var item = state.obligations.find(function (obligation) { return obligation.id === id; });
    if (!item || !window.confirm("Hapus kewajiban “" + item.name + "”?")) return;
    state.obligations = state.obligations.filter(function (obligation) { return obligation.id !== id; });
    var stored = await persistState();
    if (!stored) return;
    renderBudget();
    showToast("Kewajiban berhasil dihapus.");
  }
  async function toggleScheduledSaving(date, checked) {
    var arisan = arisanTarget();
    if (!arisan) return;
    if (checked) {
      if (state.allowanceDays.indexOf(date) >= 0) return;
      var amount = Math.min(dailyArisanAllocation(), Math.max(0, arisan.goal - arisan.saved));
      if (amount <= 0) {
        renderBudget();
        showToast("Target arisan minggu ini sudah terpenuhi.");
        return;
      }
      var now = new Date();
      arisan.saved += amount;
      state.allowanceDays.push(date);
      state.transactions.push({
        id: makeId(),
        type: "expense",
        amount: amount,
        category: "Alokasi arisan",
        description: "Setoran arisan mingguan",
        date: date,
        createdAt: now.toISOString(),
        targetId: arisan.id,
        sourceId: "",
        isAuto: false,
        isScheduled: true
      });
    } else {
      var allocation = state.transactions.find(function (item) { return item.category === "Alokasi arisan" && item.date === date; });
      if (allocation) {
        decrementTargetProgress(allocation);
        state.transactions = state.transactions.filter(function (item) { return item.id !== allocation.id; });
        if (allocation.sourceId) {
          var source = state.transactions.find(function (item) { return item.id === allocation.sourceId; });
          if (source) source.allowanceAllocated = false;
        }
      } else {
        arisan.saved = Math.max(0, arisan.saved - dailyArisanAllocation());
      }
      state.allowanceDays = state.allowanceDays.filter(function (allowanceDate) { return allowanceDate !== date; });
    }
    var stored = await persistState();
    render();
    if (stored) showToast(checked ? "Setoran arisan ditandai sudah disisihkan." : "Tanda setoran arisan dihapus.");
  }
  function bindEvents() {
    document.getElementById("pairForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!pendingSession) {
        setDeviceMessage("Sesi perangkat belum siap. Muat ulang aplikasi lalu coba lagi.");
        return;
      }
      setDeviceMessage("Menghubungkan ke data perangkat utama…");
      try {
        await window.MyMoneyDB.claimPairingCode(document.getElementById("pairCode").value);
        var pairedState = await window.MyMoneyDB.loadState();
        if (!pairedState) throw new Error("Data perangkat utama tidak ditemukan. Buat kode baru dari perangkat utama.");
        await startApplication(pendingSession, pairedState);
      } catch (error) {
        console.error("Penyambungan perangkat MyMoney gagal.", error);
        setDeviceMessage("Perangkat tidak dapat disambungkan. " + error.message);
      }
    });
    document.getElementById("startNewButton").addEventListener("click", async function () {
      if (!pendingSession) {
        setDeviceMessage("Sesi perangkat belum siap. Muat ulang aplikasi lalu coba lagi.");
        return;
      }
      state = defaultState();
      await showApplication();
      await persistState();
    });
    document.getElementById("pairDeviceButton").addEventListener("click", async function () {
      var dialog = document.getElementById("pairingDialog");
      var codeElement = document.getElementById("pairingCode");
      dialog.hidden = false;
      codeElement.textContent = "Membuat kode…";
      delete codeElement.dataset.code;
      document.getElementById("pairingMessage").textContent = "";
      try {
        var code = await window.MyMoneyDB.createPairingCode();
        codeElement.textContent = code;
        codeElement.dataset.code = code;
      } catch (error) {
        console.error("Kode sambungan MyMoney gagal dibuat.", error);
        codeElement.textContent = "";
        document.getElementById("pairingMessage").textContent = "Kode tidak dapat dibuat. " + error.message;
      }
    });
    document.getElementById("closePairingButton").addEventListener("click", function () {
      document.getElementById("pairingDialog").hidden = true;
    });
    document.getElementById("copyPairingButton").addEventListener("click", async function () {
      var code = document.getElementById("pairingCode").dataset.code;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        document.getElementById("pairingMessage").textContent = "Kode berhasil disalin.";
      } catch (error) {
        document.getElementById("pairingMessage").textContent = "Salin kode yang tampil secara manual.";
      }
    });
    document.querySelectorAll("[data-page]").forEach(function (button) {
      button.addEventListener("click", function () { showPage(button.dataset.page); });
    });
    document.querySelectorAll("[data-page-link]").forEach(function (link) {
      link.addEventListener("click", function (event) { event.preventDefault(); showPage(link.dataset.pageLink); });
    });
    document.querySelectorAll("[data-go]").forEach(function (button) {
      button.addEventListener("click", function () {
        showPage(button.dataset.go);
        if (button.dataset.type) setTransactionType(button.dataset.type, true);
      });
    });
    document.querySelectorAll(".type-tab").forEach(function (button) {
      button.addEventListener("click", function () { setTransactionType(button.dataset.type, true); });
    });
    document.getElementById("transactionForm").addEventListener("submit", submitTransaction);
    document.getElementById("targetForm").addEventListener("submit", submitTarget);
    document.getElementById("obligationForm").addEventListener("submit", submitObligation);
    document.getElementById("targetList").addEventListener("click", function (event) {
      var button = event.target.closest("[data-contribute]");
      if (button) setTransactionTypeAndGo("expense", button.dataset.contribute);
    });
    document.getElementById("dashboardTargets").addEventListener("click", function (event) {
      var button = event.target.closest("[data-contribute]");
      if (button) setTransactionTypeAndGo("expense", button.dataset.contribute);
    });
    ["recentTransactions", "historyList"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function (event) {
        var button = event.target.closest("[data-delete]");
        if (button) deleteTransaction(button.dataset.delete);
      });
    });
    document.getElementById("obligationList").addEventListener("click", function (event) {
      var button = event.target.closest("[data-delete-obligation]");
      if (button) deleteObligation(button.dataset.deleteObligation);
    });
    document.getElementById("weeklyChecklistBody").addEventListener("change", function (event) {
      var checkbox = event.target.closest("[data-check-kind]");
      if (checkbox) toggleChecklistItem(checkbox.dataset.checkDate, checkbox.dataset.checkKind, checkbox.checked);
    });
    document.getElementById("historyFilter").addEventListener("change", renderTransactionHistory);
    document.getElementById("monthFilter").addEventListener("change", renderTransactionHistory);
    document.getElementById("amount").addEventListener("input", renderTransactionAdvice);
    document.getElementById("category").addEventListener("change", renderTransactionAdvice);
    document.getElementById("targetSelect").addEventListener("change", function () {
      var target = state.targets.find(function (item) { return item.id === document.getElementById("targetSelect").value; });
      if (target) document.getElementById("category").value = categoryForTarget(target);
      renderTransactionAdvice();
    });
    document.getElementById("autoAllocate").addEventListener("change", renderTransactionAdvice);
    document.getElementById("budgetForm").addEventListener("input", updateBudgetFromForm);
    document.getElementById("budgetForm").addEventListener("change", updateBudgetFromForm);
  }

  function setDeviceMessage(message) {
    document.getElementById("deviceMessage").textContent = message;
  }

  async function showApplication() {
    document.getElementById("deviceScreen").hidden = true;
    document.getElementById("appShell").hidden = false;
    render();
    setSaveStatus("saved", "Terhubung · data tersimpan di Supabase");
    showPage(currentPage);
  }

  async function startApplication(session, loadedState) {
    setSaveStatus("", "Memuat data dari Supabase…");
    try {
      var loaded = typeof loadedState === "undefined"
        ? await window.MyMoneyDB.loadState()
        : loadedState;
      if (!loaded) {
        pendingSession = session;
        document.getElementById("appShell").hidden = true;
        document.getElementById("deviceScreen").hidden = false;
        setDeviceMessage("");
        return;
      }
      state = normalizeState(loaded);
      var currentWeek = weekKey(new Date());
      var needsSave = state.arisanWeek !== currentWeek;
      if (state.arisanWeek !== currentWeek) {
        state.arisanWeek = currentWeek;
        state.allowanceDays = [];
        state.weeklyChecks = {};
        var arisan = arisanTarget();
        if (arisan) arisan.saved = 0;
      }
      pendingSession = null;
      await showApplication();
      if (needsSave) await persistState();
    } catch (error) {
      console.error("Data Supabase MyMoney gagal dimuat.", error);
      document.getElementById("appShell").hidden = true;
      document.getElementById("deviceScreen").hidden = false;
      setDeviceMessage("Data tidak dapat dimuat. Periksa konfigurasi dan koneksi Supabase. " + error.message);
    }
  }

  async function initialize() {
    bindEvents();
    updateToday();
    try {
      window.MyMoneyDB.initialize();
      var session = await window.MyMoneyDB.ensureDeviceSession();
      await startApplication(session);
    } catch (error) {
      console.error("Supabase MyMoney gagal diinisialisasi.", error);
      setDeviceMessage(error.message);
    }
  }
  initialize();
}());
