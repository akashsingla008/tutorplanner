// State - use safe JSON parsing to prevent crashes from corrupted localStorage
function safeJsonParse(key, defaultValue) {
  try {
    const item = localStorage.getItem(key);
    if (item === null) return defaultValue;
    const parsed = JSON.parse(item);
    // Validate expected type - only return default if type mismatch
    if (Array.isArray(defaultValue)) {
      // Default is array, parsed must also be array
      return Array.isArray(parsed) ? parsed : defaultValue;
    }
    if (typeof defaultValue === 'object' && defaultValue !== null) {
      // Default is plain object, parsed must be plain object (not array, not null)
      return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed : defaultValue;
    }
    return parsed;
  } catch (e) {
    console.error(`Error parsing localStorage key "${key}":`, e);
    return defaultValue;
  }
}

let classes = safeJsonParse("classes", []);
let editingIndex = null;
let currentWeekOffset = 0;
let selectedDuration = 60; // Default 1 hour
let draggedClassIndex = null;
let isCopyDrag = false;
let reportPeriod = 'week';
let reportOffset = 0; // Offset for navigating previous/next weeks/months
let customStartDate = null;
let customEndDate = null;
let defaultRate = parseInt(localStorage.getItem('defaultRate')) || 500;
let studentRates = safeJsonParse('studentRates', {});
let paymentStatus = safeJsonParse('paymentStatus', {});
let isSelectMode = false;
let selectedClasses = new Set();
let allowClashOverride = false; // Flag to allow saving despite clash

// Days of the week
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Working hours for auto-suggest (configurable)
const WORKING_HOURS = { start: 8, end: 20 }; // 8 AM to 8 PM

// DOM Elements
const weekGrid = document.getElementById("weekGrid");
const modal = document.getElementById("modal");
const classForm = document.getElementById("classForm");
const modalTitle = document.getElementById("modalTitle");
const deleteBtn = document.getElementById("deleteBtn");
const duplicateBtn = document.getElementById("duplicateBtn");
const clashWarning = document.getElementById("clashWarning");
const formClashWarning = document.getElementById("formClashWarning");
const suggestedSlots = document.getElementById("suggestedSlots");
const slotsList = document.getElementById("slotsList");
const studentSelect = document.getElementById("studentSelect");
const studentSchedule = document.getElementById("studentSchedule");
const dragHint = document.getElementById("dragHint");
const copyToDaySection = document.getElementById("copyToDaySection");
const cancelSection = document.getElementById("cancelSection");
const restoreSection = document.getElementById("restoreSection");
const cancelReasonSpan = document.getElementById("cancelReason");
const pendingConfirmSection = document.getElementById("pendingConfirmSection");
const checkWithStudentBtn = document.getElementById("checkWithStudentBtn");

// Cancel reason labels
const CANCEL_REASONS = {
  student: "Student Unavailable",
  tutor: "Tutor Unavailable",
  holiday: "Holiday",
  other: "Other Reason"
};

// Form fields
const existingStudentSelect = document.getElementById("existingStudentSelect");
const studentNameInput = document.getElementById("studentName");
const daySelect = document.getElementById("daySelect");
const startTimeInput = document.getElementById("startTime");
const endTimeInput = document.getElementById("endTime");

// Initialize
document.addEventListener("DOMContentLoaded", init);

function init() {
  // Check if data was lost and auto-recover from backup
  checkAndRecoverData();
  migrateClassesToDateFormat();
  cleanupOldClasses();
  renderWeekGrid();
  setupEventListeners();
  updateStudentDropdowns();
  checkForClashes();
  checkAndCreateBackup();
  initNotifications();
  startClassReminderCheck();
  initCelebrations();
}

// Auto-recover data if classes array is empty but backups exist
function checkAndRecoverData() {
  if (classes.length > 0) return; // Data exists, no recovery needed

  // Try to recover from auto backups first
  const autoBackups = safeJsonParse('autoBackups', []);
  if (autoBackups.length > 0 && autoBackups[0].classes && autoBackups[0].classes.length > 0) {
    console.log('Auto-recovering data from backup...');
    const backup = autoBackups[0];
    classes = backup.classes;
    studentRates = backup.studentRates || studentRates;
    paymentStatus = backup.paymentStatus || paymentStatus;
    defaultRate = backup.defaultRate || defaultRate;

    // Save recovered data
    saveClasses();
    localStorage.setItem('studentRates', JSON.stringify(studentRates));
    localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
    localStorage.setItem('defaultRate', defaultRate);

    console.log(`Recovered ${classes.length} classes from auto backup`);
    showToast(`Recovered ${classes.length} classes from backup!`);
    return;
  }

  // Try cleanup backups if no auto backups
  const cleanupBackups = safeJsonParse('cleanupBackups', []);
  if (cleanupBackups.length > 0 && cleanupBackups[0].allClasses && cleanupBackups[0].allClasses.length > 0) {
    console.log('Auto-recovering data from cleanup backup...');
    const backup = cleanupBackups[0];
    classes = backup.allClasses;
    studentRates = backup.studentRates || studentRates;
    paymentStatus = backup.paymentStatus || paymentStatus;
    defaultRate = backup.defaultRate || defaultRate;

    // Save recovered data
    saveClasses();
    localStorage.setItem('studentRates', JSON.stringify(studentRates));
    localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
    localStorage.setItem('defaultRate', defaultRate);

    console.log(`Recovered ${classes.length} classes from cleanup backup`);
    showToast(`Recovered ${classes.length} classes from backup!`);
  }
}

// Migrate existing classes to include date field
function migrateClassesToDateFormat() {
  let needsMigration = false;
  const currentWeekStart = getWeekStartDate(0);

  classes.forEach((cls) => {
    if (!cls.date) {
      needsMigration = true;
      // Assign date based on day name for current week
      const dayIndex = DAYS.indexOf(cls.day);
      if (dayIndex !== -1) {
        const classDate = new Date(currentWeekStart);
        classDate.setDate(currentWeekStart.getDate() + dayIndex);
        cls.date = classDate.toISOString().split('T')[0]; // YYYY-MM-DD format
      }
    }
  });

  if (needsMigration) {
    saveClasses();
    console.log('Migrated classes to date-based format');
  }
}

// Clean up classes older than 3 months (with automatic backup)
function cleanupOldClasses() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoffDate = threeMonthsAgo.toISOString().split('T')[0];

  // Find old classes
  const oldClasses = classes.filter(cls => cls.date && cls.date < cutoffDate);

  if (oldClasses.length === 0) {
    return; // Nothing to clean up
  }

  // Create backup before cleanup
  const cleanupBackup = {
    timestamp: new Date().toISOString(),
    reason: 'auto-cleanup-3months',
    cutoffDate: cutoffDate,
    classesRemoved: oldClasses.length,
    classes: oldClasses,
    allClasses: classes,
    studentRates: studentRates,
    paymentStatus: paymentStatus,
    defaultRate: defaultRate
  };

  // Store cleanup backup separately
  let cleanupBackups = safeJsonParse('cleanupBackups', []);
  cleanupBackups.unshift(cleanupBackup);
  // Keep only last 6 cleanup backups (covering 18 months of history)
  cleanupBackups = cleanupBackups.slice(0, 6);
  localStorage.setItem('cleanupBackups', JSON.stringify(cleanupBackups));

  // Remove old classes
  classes = classes.filter(cls => !cls.date || cls.date >= cutoffDate);
  saveClasses();

  console.log(`Cleaned up ${oldClasses.length} classes older than ${cutoffDate}. Backup created.`);
}

// Event Listeners Setup
function setupEventListeners() {
  // Navigation tabs
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  // Week navigation
  document.getElementById("prevWeek").addEventListener("click", () => navigateWeek(-1));
  document.getElementById("nextWeek").addEventListener("click", () => navigateWeek(1));

  // Copy week button
  document.getElementById("copyWeekBtn").addEventListener("click", showCopyWeekDialog);

  // Add class button
  document.getElementById("addBtn").addEventListener("click", openAddModal);

  // Modal controls
  document.getElementById("closeModal").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Form submission
  classForm.addEventListener("submit", handleFormSubmit);

  // Delete and Duplicate buttons
  deleteBtn.addEventListener("click", handleDelete);
  duplicateBtn.addEventListener("click", handleDuplicate);

  // Copy to days button
  document.getElementById("copyToDaysBtn").addEventListener("click", handleCopyToDays);

  // Cancel reason buttons
  document.querySelectorAll(".cancel-reason-btn").forEach(btn => {
    btn.addEventListener("click", () => handleCancelClass(btn.dataset.reason));
  });

  // Restore button
  document.getElementById("restoreBtn").addEventListener("click", handleRestoreClass);

  // Notify Student about cancellation button
  document.getElementById("notifyStudentCancelBtn").addEventListener("click", handleNotifyStudentCancellation);

  // Allow Clash button
  document.getElementById("allowClashBtn").addEventListener("click", handleAllowClash);

  // Check with Student button
  checkWithStudentBtn.addEventListener("click", handleCheckWithStudent);

  // Confirm Class button (after student confirms)
  document.getElementById("confirmClassBtn").addEventListener("click", handleConfirmClass);

  // Resend WhatsApp button
  document.getElementById("resendWhatsAppBtn").addEventListener("click", handleResendWhatsApp);

  // Real-time clash detection in form
  [daySelect, startTimeInput, endTimeInput].forEach(input => {
    input.addEventListener("change", () => {
      checkFormClash();
      updateQuickSlotsClashState();
      updateCopyToDayClashState();
    });
  });

  // Student selection - clear the other when one is selected
  existingStudentSelect.addEventListener("change", () => {
    if (existingStudentSelect.value) {
      studentNameInput.value = "";
    }
  });

  studentNameInput.addEventListener("input", () => {
    if (studentNameInput.value) {
      existingStudentSelect.value = "";
    }
  });

  // Quick time slots
  document.querySelectorAll(".quick-slot").forEach(slot => {
    slot.addEventListener("click", () => {
      const start = slot.dataset.start;
      const end = slot.dataset.end;
      startTimeInput.value = start;
      endTimeInput.value = end;

      // Update active state
      document.querySelectorAll(".quick-slot").forEach(s => s.classList.remove("active"));
      slot.classList.add("active");

      checkFormClash();
      updateCopyToDayClashState();
    });
  });

  // Duration buttons
  document.querySelectorAll(".duration-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedDuration = parseInt(btn.dataset.minutes);

      // Update active state
      document.querySelectorAll(".duration-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // Recalculate end time if start time is set
      if (startTimeInput.value) {
        endTimeInput.value = addMinutesToTime(startTimeInput.value, selectedDuration);
        checkFormClash();
        updateQuickSlotsClashState();
        updateCopyToDayClashState();
      }
    });
  });

  // Auto-calculate end time when start time changes
  startTimeInput.addEventListener("change", () => {
    if (startTimeInput.value) {
      endTimeInput.value = addMinutesToTime(startTimeInput.value, selectedDuration);

      // Clear quick slot active state since custom time was entered
      document.querySelectorAll(".quick-slot").forEach(s => s.classList.remove("active"));
    }
    checkFormClash();
    updateQuickSlotsClashState();
    updateCopyToDayClashState();
  });

  // Student view dropdown
  studentSelect.addEventListener("change", renderStudentSchedule);

  // Report period buttons
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      reportPeriod = btn.dataset.period;
      reportOffset = 0; // Reset offset when changing period

      const customDateRange = document.getElementById("customDateRange");
      if (reportPeriod === "custom") {
        customDateRange.classList.remove("hidden");
      } else {
        customDateRange.classList.add("hidden");
        renderReport();
      }
    });
  });

  // Report navigation buttons
  document.getElementById("prevReport").addEventListener("click", () => navigateReport(-1));
  document.getElementById("nextReport").addEventListener("click", () => navigateReport(1));

  // Apply custom date range
  document.getElementById("applyDateRange").addEventListener("click", () => {
    customStartDate = document.getElementById("reportStartDate").value;
    customEndDate = document.getElementById("reportEndDate").value;
    if (customStartDate && customEndDate) {
      renderReport();
    }
  });

  // Default rate change
  document.getElementById("defaultRate").value = defaultRate;
  document.getElementById("defaultRate").addEventListener("change", (e) => {
    let newRate = parseInt(e.target.value);

    // Validate rate - must be non-negative
    if (isNaN(newRate) || newRate < 0) {
      newRate = 0;
      e.target.value = 0;
      showToast('Rate must be a positive number');
    }

    // Cap at reasonable maximum (100000)
    if (newRate > 100000) {
      newRate = 100000;
      e.target.value = 100000;
      showToast('Rate capped at maximum value');
    }

    defaultRate = newRate;
    localStorage.setItem('defaultRate', defaultRate);
    renderReport();
  });

  // Track Ctrl/Cmd key for copy drag
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) {
      isCopyDrag = true;
      document.querySelectorAll(".class-card.dragging").forEach(card => {
        card.classList.add("drag-copy");
      });
    }
  });

  document.addEventListener("keyup", (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      isCopyDrag = false;
      document.querySelectorAll(".class-card").forEach(card => {
        card.classList.remove("drag-copy");
      });
    }
  });

  // Event delegation for weekGrid - prevents memory leaks from repeated listener attachment
  weekGrid.addEventListener("click", handleWeekGridClick);
  weekGrid.addEventListener("dragstart", handleDragStart);
  weekGrid.addEventListener("dragend", handleDragEnd);
  weekGrid.addEventListener("dragover", handleDragOver);
  weekGrid.addEventListener("dragleave", handleDragLeave);
  weekGrid.addEventListener("drop", handleDrop);
  weekGrid.addEventListener("change", handleWeekGridChange);

  // Event delegation for suggested slot chips - prevents duplicate listeners
  initSlotChipsEventDelegation();

  // Select mode button event listeners (CSP-compliant - no inline onclick)
  document.getElementById("selectModeBtn").addEventListener("click", enterSelectMode);
  document.getElementById("selectCancelBtn").addEventListener("click", exitSelectMode);
  document.getElementById("selectAllBtn").addEventListener("click", selectAllClasses);
  document.getElementById("deleteSelectedBtn").addEventListener("click", deleteSelectedClasses);

  // Header button event listeners (CSP-compliant - no inline onclick)
  document.getElementById("notificationBtn").addEventListener("click", toggleNotifications);
  document.getElementById("backupBtn").addEventListener("click", showBackupDialog);
}

// Handle clicks on week grid using event delegation
function handleWeekGridClick(e) {
  const card = e.target.closest(".class-card");
  const copyBtn = e.target.closest(".copy-class-btn");

  // Handle copy button click
  if (copyBtn) {
    e.stopPropagation();
    showCopyClassDialog(parseInt(copyBtn.dataset.index));
    return;
  }

  // Handle class card click
  if (card) {
    // Handle select mode
    if (isSelectMode) {
      if (!e.target.classList.contains("class-select-cb")) {
        const index = parseInt(card.dataset.index);
        toggleClassSelection(index);
      }
      return;
    }
    // Don't open modal if we just finished dragging
    if (card.classList.contains("dragging")) {
      return;
    }
    openEditModal(parseInt(card.dataset.index));
  }
}

// Handle checkbox changes in week grid using event delegation
function handleWeekGridChange(e) {
  if (e.target.classList.contains("class-select-cb")) {
    e.stopPropagation();
    const index = parseInt(e.target.dataset.index);
    toggleClassSelection(index);
  }
}

// View Switching
function switchView(viewName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));

  document.querySelector(`[data-view="${viewName}"]`).classList.add("active");
  document.getElementById(`${viewName}-view`).classList.add("active");

  if (viewName === "students") {
    updateStudentDropdowns();
  } else if (viewName === "reports") {
    renderReport();
  }
}

// Week Navigation
function navigateWeek(direction) {
  currentWeekOffset += direction;
  updateWeekLabel();
  renderWeekGrid();
}

function updateWeekLabel() {
  const label = document.getElementById("weekLabel");
  const startDate = getWeekStartDate(currentWeekOffset);
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);
  const dateRange = `${formatDateShort(startDate)} - ${formatDateShort(endDate)}`;

  if (currentWeekOffset === 0) {
    label.textContent = `This Week (${dateRange})`;
  } else if (currentWeekOffset === 1) {
    label.textContent = `Next Week (${dateRange})`;
  } else if (currentWeekOffset === -1) {
    label.textContent = `Last Week (${dateRange})`;
  } else if (currentWeekOffset === 2) {
    label.textContent = `In 2 Weeks (${dateRange})`;
  } else if (currentWeekOffset === -2) {
    label.textContent = `2 Weeks Ago (${dateRange})`;
  } else {
    label.textContent = `Week of ${formatDateShort(startDate)}`;
  }
}

function getWeekStartDate(offset) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff + (offset * 7));
  return monday;
}

function formatDateShort(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Copy Week Feature
function showCopyWeekDialog() {
  if (classes.length === 0) {
    alert("No classes to copy. Add some classes first.");
    return;
  }

  const options = [
    "Copy all classes to next week",
    "Copy Monday's classes to all weekdays",
    "Copy Monday's classes to specific days"
  ];

  const choice = prompt(
    `Copy Schedule Options:\n\n` +
    `1 - Copy all classes to next week\n` +
    `2 - Copy Monday's classes to all weekdays (Tue-Fri)\n` +
    `3 - Cancel\n\n` +
    `Enter 1, 2, or 3:`
  );

  if (choice === "1") {
    copyAllToNextWeek();
  } else if (choice === "2") {
    copyMondayToWeekdays();
  }
}

function copyAllToNextWeek() {
  // Get classes from current week only
  const currentWeekStart = getWeekStartDate(currentWeekOffset);
  const currentWeekEnd = new Date(currentWeekStart);
  currentWeekEnd.setDate(currentWeekStart.getDate() + 6);
  const currentWeekClasses = getClassesInRange(currentWeekStart, currentWeekEnd);

  if (currentWeekClasses.length === 0) {
    alert("No classes in this week to copy.");
    return;
  }

  const nextWeekStart = getWeekStartDate(currentWeekOffset + 1);
  let addedCount = 0;
  let skippedCount = 0;

  currentWeekClasses.forEach(cls => {
    // Calculate new date for next week
    const dayIndex = DAYS.indexOf(cls.day);
    const newDate = new Date(nextWeekStart);
    newDate.setDate(nextWeekStart.getDate() + dayIndex);
    const newDateStr = newDate.toISOString().split('T')[0];

    const newClass = {
      ...cls,
      date: newDateStr,
      cancelled: false,
      cancelReason: undefined,
      pendingConfirmation: false,
      completedDate: undefined
    };

    // Check if this exact class already exists for that date
    const exists = classes.some(c =>
      c.student === newClass.student &&
      c.date === newClass.date &&
      c.start === newClass.start &&
      c.end === newClass.end
    );

    if (!exists && !hasClash(newClass)) {
      classes.push(newClass);
      addedCount++;
    } else {
      skippedCount++;
    }
  });

  saveClasses();
  renderWeekGrid();

  alert(`Copied ${addedCount} classes to next week. ${skippedCount > 0 ? `Skipped ${skippedCount} due to duplicates or clashes.` : ''}`);
}

function copyMondayToWeekdays() {
  // Get Monday of current displayed week
  const currentWeekStart = getWeekStartDate(currentWeekOffset);
  const mondayDateStr = currentWeekStart.toISOString().split('T')[0];
  const mondayClasses = classes.filter(c => c.date === mondayDateStr);

  if (mondayClasses.length === 0) {
    alert("No Monday classes in this week to copy.");
    return;
  }

  const targetDays = ["Tuesday", "Wednesday", "Thursday", "Friday"];
  let addedCount = 0;
  let skippedCount = 0;

  mondayClasses.forEach(mondayClass => {
    targetDays.forEach((day, dayOffset) => {
      // Calculate date for target day (Tue=1, Wed=2, Thu=3, Fri=4 offset from Monday)
      const targetDate = new Date(currentWeekStart);
      targetDate.setDate(currentWeekStart.getDate() + dayOffset + 1);
      const targetDateStr = targetDate.toISOString().split('T')[0];

      const newClass = {
        ...mondayClass,
        day,
        date: targetDateStr,
        cancelled: false,
        cancelReason: undefined,
        pendingConfirmation: false
      };

      // Check for clashes
      if (!hasClash(newClass)) {
        classes.push(newClass);
        addedCount++;
      } else {
        skippedCount++;
      }
    });
  });

  saveClasses();
  renderWeekGrid();

  alert(`Copied ${addedCount} classes to weekdays. ${skippedCount > 0 ? `Skipped ${skippedCount} due to clashes.` : ''}`);
}

// Copy single class to another day (mobile-friendly)
function showCopyClassDialog(classIndex) {
  // Validate index bounds
  if (classIndex < 0 || classIndex >= classes.length) {
    console.error('showCopyClassDialog: Invalid class index', classIndex);
    return;
  }

  const cls = classes[classIndex];
  if (!cls) return;

  const currentDay = cls.day;

  // Build options for available days
  const availableDays = DAYS.filter(day => day !== currentDay);
  const dayOptions = availableDays.map((day, i) => `${i + 1} - ${day}`).join('\n');

  const choice = prompt(
    `Copy "${cls.student}" (${formatTime(cls.start)} - ${formatTime(cls.end)}) to:\n\n` +
    `${dayOptions}\n\n` +
    `Enter number (1-${availableDays.length}) or 0 to cancel:`
  );

  if (!choice || choice === '0') return;

  const dayIndex = parseInt(choice) - 1;
  if (isNaN(dayIndex) || dayIndex < 0 || dayIndex >= availableDays.length) {
    alert('Invalid selection');
    return;
  }

  const targetDay = availableDays[dayIndex];

  // Calculate the date for the target day within the current week
  const weekStart = getWeekStartDate(currentWeekOffset);
  const targetDayIndex = DAYS.indexOf(targetDay);
  const targetDate = new Date(weekStart);
  targetDate.setDate(weekStart.getDate() + targetDayIndex);
  const targetDateStr = targetDate.toISOString().split('T')[0];

  const newClass = { ...cls, day: targetDay, date: targetDateStr };

  // Remove cancel status when copying
  delete newClass.cancelled;
  delete newClass.cancelReason;
  delete newClass.cancelledAt;
  delete newClass.customCancelReason;
  delete newClass.pendingConfirmation;

  if (hasClash(newClass)) {
    alert(`Cannot copy to ${targetDay} - time clash detected!`);
    return;
  }

  classes.push(newClass);
  saveClasses();
  renderWeekGrid();
  updateStudentDropdowns();

  showToast(`Copied ${cls.student}'s class to ${targetDay}`);
}

// Render Week Grid with Drag and Drop
function renderWeekGrid() {
  weekGrid.innerHTML = "";
  const weekStart = getWeekStartDate(currentWeekOffset);

  // Show drag hint if there are classes
  if (classes.length > 0) {
    dragHint.classList.remove("hidden");
  } else {
    dragHint.classList.add("hidden");
  }

  // Update select mode UI
  updateSelectModeUI();

  DAYS.forEach((day, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const dateStr = date.toISOString().split('T')[0];

    const dayColumn = document.createElement("div");
    dayColumn.className = "day-column";
    dayColumn.dataset.day = day;

    // Filter classes by actual date (not just day name)
    const dayClasses = classes.filter(c => c.date === dateStr);
    const clashingIndices = findClashingClasses(dayClasses);

    dayColumn.innerHTML = `
      <div class="day-header">
        <span>${day}</span>
        <span class="date">${formatDateShort(date)}</span>
      </div>
      <div class="day-classes">
        ${dayClasses.length === 0
          ? '<div class="empty-slot">No classes</div>'
          : dayClasses
              .sort((a, b) => a.start.localeCompare(b.start))
              .map((c, i) => {
                const globalIndex = classes.indexOf(c);
                const hasClash = clashingIndices.includes(i);
                const isCancelled = c.cancelled;
                const isPending = c.pendingConfirmation;
                const cancelLabel = isCancelled ? CANCEL_REASONS[c.cancelReason] || 'Cancelled' : '';
                const isSelected = selectedClasses.has(globalIndex);
                return `
                  <div class="class-card ${hasClash ? 'clash' : ''} ${isCancelled ? 'cancelled' : ''} ${isPending ? 'pending' : ''} ${isSelected ? 'selected' : ''}"
                       data-index="${globalIndex}"
                       draggable="${!isCancelled && !isPending && !isSelectMode}">
                    ${isSelectMode ? `
                      <label class="select-checkbox">
                        <input type="checkbox" class="class-select-cb" data-index="${globalIndex}" ${isSelected ? 'checked' : ''} />
                      </label>
                    ` : ''}
                    <div class="class-card-content">
                      <div class="student-name">${escapeHtml(c.student)}</div>
                      <div class="class-time">${formatTime(c.start)} - ${formatTime(c.end)}</div>
                      ${isCancelled ? `<div class="cancel-badge">${cancelLabel}</div>` : ''}
                      ${isPending ? `<div class="pending-badge">⏳ Awaiting confirmation</div>` : ''}
                    </div>
                    ${!isCancelled && !isPending && !isSelectMode ? `<button class="copy-class-btn" data-index="${globalIndex}" title="Copy to another day">⧉</button>` : ''}
                  </div>
                `;
              }).join("")
        }
      </div>
    `;

    // Event listeners are handled via event delegation on weekGrid (setupEventListeners)
    // This prevents memory leaks from attaching listeners on every re-render

    weekGrid.appendChild(dayColumn);
  });

  checkForClashes();
}

// Toggle class selection
function toggleClassSelection(index) {
  if (selectedClasses.has(index)) {
    selectedClasses.delete(index);
  } else {
    selectedClasses.add(index);
  }
  renderWeekGrid();
  updateSelectModeUI();
}

// Update select mode UI
function updateSelectModeUI() {
  const selectBar = document.getElementById("selectModeBar");
  const selectedCount = document.getElementById("selectedCount");

  if (isSelectMode) {
    selectBar.classList.remove("hidden");
    selectedCount.textContent = selectedClasses.size;
  } else {
    selectBar.classList.add("hidden");
  }
}

// Enter select mode
function enterSelectMode() {
  isSelectMode = true;
  selectedClasses.clear();
  renderWeekGrid();
}

// Exit select mode
function exitSelectMode() {
  isSelectMode = false;
  selectedClasses.clear();
  renderWeekGrid();
}

// Delete selected classes
function deleteSelectedClasses() {
  if (selectedClasses.size === 0) {
    showToast("No classes selected");
    return;
  }

  const count = selectedClasses.size;
  if (confirm(`Are you sure you want to delete ${count} class${count > 1 ? 'es' : ''}? This cannot be undone.`)) {
    // Sort indices in descending order to delete from end first
    const indicesToDelete = Array.from(selectedClasses).sort((a, b) => b - a);
    indicesToDelete.forEach(index => {
      classes.splice(index, 1);
    });

    saveClasses();
    exitSelectMode();
    updateStudentDropdowns();
    showToast(`Deleted ${count} class${count > 1 ? 'es' : ''}`);
  }
}

// Select all classes
function selectAllClasses() {
  classes.forEach((_, index) => {
    selectedClasses.add(index);
  });
  renderWeekGrid();
}

// Drag and Drop Handlers
function handleDragStart(e) {
  const card = e.target.closest(".class-card");
  if (!card || !card.dataset.index) return;

  const index = parseInt(card.dataset.index);
  // Validate index is within bounds
  if (isNaN(index) || index < 0 || index >= classes.length) {
    e.preventDefault();
    return;
  }

  draggedClassIndex = index;
  card.classList.add("dragging");

  if (isCopyDrag) {
    card.classList.add("drag-copy");
  }

  // Set drag data
  e.dataTransfer.effectAllowed = isCopyDrag ? "copy" : "move";
  e.dataTransfer.setData("text/plain", draggedClassIndex);
}

function handleDragEnd(e) {
  const card = e.target.closest(".class-card");
  if (card) {
    card.classList.remove("dragging", "drag-copy");
  }
  draggedClassIndex = null;

  // Remove all drag-over states
  document.querySelectorAll(".day-column").forEach(col => {
    col.classList.remove("drag-over", "drag-over-clash");
  });
}

function handleDragOver(e) {
  e.preventDefault();
  const dayColumn = e.target.closest(".day-column");
  if (!dayColumn) return;

  const targetDay = dayColumn.dataset.day;

  // Validate draggedClassIndex
  if (draggedClassIndex === null || draggedClassIndex < 0 || draggedClassIndex >= classes.length) return;

  const draggedClass = classes[draggedClassIndex];
  if (!draggedClass) return;

  const testClass = { ...draggedClass, day: targetDay };

  // Check if dropping here would cause a clash
  const wouldClash = hasClash(testClass, isCopyDrag ? null : draggedClassIndex);

  dayColumn.classList.remove("drag-over", "drag-over-clash");
  if (wouldClash) {
    dayColumn.classList.add("drag-over-clash");
    e.dataTransfer.dropEffect = "none";
  } else {
    dayColumn.classList.add("drag-over");
    e.dataTransfer.dropEffect = isCopyDrag ? "copy" : "move";
  }
}

function handleDragLeave(e) {
  const dayColumn = e.target.closest(".day-column");
  if (dayColumn) {
    dayColumn.classList.remove("drag-over", "drag-over-clash");
  }
}

function handleDrop(e) {
  e.preventDefault();
  const dayColumn = e.target.closest(".day-column");
  if (!dayColumn) return;

  const targetDay = dayColumn.dataset.day;

  dayColumn.classList.remove("drag-over", "drag-over-clash");

  // Validate draggedClassIndex before accessing classes array
  if (draggedClassIndex === null || draggedClassIndex < 0 || draggedClassIndex >= classes.length) return;

  const draggedClass = classes[draggedClassIndex];
  if (!draggedClass) return;

  // Calculate the date for the target day within the current week
  const weekStart = getWeekStartDate(currentWeekOffset);
  const targetDayIndex = DAYS.indexOf(targetDay);
  const targetDate = new Date(weekStart);
  targetDate.setDate(weekStart.getDate() + targetDayIndex);
  const targetDateStr = targetDate.toISOString().split('T')[0];

  const newClass = { ...draggedClass, day: targetDay, date: targetDateStr };

  // Check for clash
  const excludeIndex = isCopyDrag ? null : draggedClassIndex;
  if (hasClash(newClass, excludeIndex)) {
    showToast("Cannot drop here - time clash detected!");
    return;
  }

  if (isCopyDrag) {
    // Copy the class - remove status flags
    delete newClass.cancelled;
    delete newClass.cancelReason;
    delete newClass.pendingConfirmation;
    classes.push(newClass);
    showToast(`Copied ${draggedClass.student}'s class to ${targetDay}`);
  } else {
    // Move the class
    classes[draggedClassIndex] = newClass;
    showToast(`Moved ${draggedClass.student}'s class to ${targetDay}`);
  }

  saveClasses();
  renderWeekGrid();
  updateStudentDropdowns();
}

// Toast notification
function showToast(message) {
  // Remove existing toast
  const existingToast = document.querySelector(".toast");
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 100px;
    left: 50%;
    transform: translateX(-50%);
    background: #1f2937;
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 0.9rem;
    z-index: 300;
    animation: fadeInUp 0.3s ease;
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Find clashing classes within a day (ignoring cancelled classes)
function findClashingClasses(dayClasses) {
  const clashing = [];
  for (let i = 0; i < dayClasses.length; i++) {
    if (dayClasses[i].cancelled) continue; // Skip cancelled classes
    for (let j = i + 1; j < dayClasses.length; j++) {
      if (dayClasses[j].cancelled) continue; // Skip cancelled classes
      if (timesOverlap(dayClasses[i], dayClasses[j])) {
        if (!clashing.includes(i)) clashing.push(i);
        if (!clashing.includes(j)) clashing.push(j);
      }
    }
  }
  return clashing;
}

// Check if two time slots overlap
function timesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Check for clashes and show/hide warning banner
function checkForClashes() {
  let hasClashFlag = false;

  DAYS.forEach(day => {
    const dayClasses = classes.filter(c => c.day === day && !c.cancelled);

    // Check each pair for unexpected clashes
    for (let i = 0; i < dayClasses.length; i++) {
      for (let j = i + 1; j < dayClasses.length; j++) {
        if (timesOverlap(dayClasses[i], dayClasses[j])) {
          // Only show warning if NEITHER class has allowedClash flag
          // (if one has it, the user intentionally allowed this pair)
          if (!dayClasses[i].allowedClash && !dayClasses[j].allowedClash) {
            hasClashFlag = true;
          }
        }
      }
    }
  });

  if (hasClashFlag) {
    clashWarning.classList.remove("hidden");
  } else {
    clashWarning.classList.add("hidden");
  }
}

// Modal Functions
function openAddModal() {
  editingIndex = null;
  modalTitle.textContent = "Add New Class";
  deleteBtn.classList.add("hidden");
  duplicateBtn.classList.add("hidden");
  copyToDaySection.classList.add("hidden");
  classForm.reset();

  // Reset UI state
  resetFormUI();
  updateStudentDropdowns();

  // Show Check with Student button for new classes
  checkWithStudentBtn.classList.remove("hidden");

  modal.classList.remove("hidden");
  existingStudentSelect.focus();
}

function openEditModal(index) {
  // Validate index bounds
  if (index < 0 || index >= classes.length) {
    console.error('openEditModal: Invalid class index', index);
    return;
  }

  const cls = classes[index];
  if (!cls) return;

  editingIndex = index;

  modalTitle.textContent = "Edit Class";
  deleteBtn.classList.remove("hidden");
  duplicateBtn.classList.remove("hidden");

  // Show cancel or restore section based on class state
  if (cls.cancelled) {
    cancelSection.classList.add("hidden");
    restoreSection.classList.remove("hidden");
    cancelReasonSpan.textContent = CANCEL_REASONS[cls.cancelReason] || 'Unknown';
    copyToDaySection.classList.add("hidden");
    pendingConfirmSection.classList.add("hidden");
    checkWithStudentBtn.classList.add("hidden");
  } else if (cls.pendingConfirmation) {
    // Show pending confirmation UI
    cancelSection.classList.add("hidden");
    restoreSection.classList.add("hidden");
    copyToDaySection.classList.add("hidden");
    pendingConfirmSection.classList.remove("hidden");
    checkWithStudentBtn.classList.add("hidden");
  } else {
    cancelSection.classList.remove("hidden");
    restoreSection.classList.add("hidden");
    copyToDaySection.classList.remove("hidden");
    pendingConfirmSection.classList.add("hidden");
    checkWithStudentBtn.classList.remove("hidden"); // Show for confirmed classes to resend
  }

  // Set student - check if exists in dropdown
  updateStudentDropdowns();
  const studentExists = [...existingStudentSelect.options].some(opt => opt.value === cls.student);
  if (studentExists) {
    existingStudentSelect.value = cls.student;
    studentNameInput.value = "";
  } else {
    existingStudentSelect.value = "";
    studentNameInput.value = cls.student;
  }

  daySelect.value = cls.day;
  startTimeInput.value = cls.start;
  endTimeInput.value = cls.end;

  // Calculate and set duration
  const duration = getMinutesBetween(cls.start, cls.end);
  selectedDuration = duration;
  document.querySelectorAll(".duration-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.minutes) === duration);
  });

  // Highlight matching quick slot if any
  document.querySelectorAll(".quick-slot").forEach(slot => {
    const matches = slot.dataset.start === cls.start && slot.dataset.end === cls.end;
    slot.classList.toggle("active", matches);
  });

  // Reset copy-to-day checkboxes
  document.querySelectorAll(".day-checkbox input").forEach(cb => {
    cb.checked = false;
    cb.closest(".day-checkbox").classList.remove("has-clash");
  });

  formClashWarning.classList.add("hidden");
  suggestedSlots.classList.add("hidden");
  updateQuickSlotsClashState();
  updateCopyToDayClashState();

  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
  classForm.reset();
  editingIndex = null;
  resetFormUI();
}

function resetFormUI() {
  formClashWarning.classList.add("hidden");
  suggestedSlots.classList.add("hidden");
  copyToDaySection.classList.add("hidden");
  cancelSection.classList.add("hidden");
  restoreSection.classList.add("hidden");
  pendingConfirmSection.classList.add("hidden");
  checkWithStudentBtn.classList.add("hidden");
  allowClashOverride = false; // Reset clash override flag

  // Reset duration to default
  selectedDuration = 60;
  document.querySelectorAll(".duration-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.minutes === "60");
  });

  // Clear quick slot selection
  document.querySelectorAll(".quick-slot").forEach(s => {
    s.classList.remove("active");
    s.classList.remove("clash");
  });

  // Reset day checkboxes
  document.querySelectorAll(".day-checkbox input").forEach(cb => {
    cb.checked = false;
    cb.closest(".day-checkbox").classList.remove("has-clash");
  });
}

// Update quick slots to show which ones have clashes
function updateQuickSlotsClashState() {
  const day = daySelect.value;
  if (!day) return;

  document.querySelectorAll(".quick-slot").forEach(slot => {
    const testClass = {
      day,
      start: slot.dataset.start,
      end: slot.dataset.end
    };

    const wouldClash = hasClash(testClass, editingIndex);
    slot.classList.toggle("clash", wouldClash);
  });
}

// Update copy-to-day checkboxes to show clash state
function updateCopyToDayClashState() {
  const start = startTimeInput.value;
  const end = endTimeInput.value;
  const currentDay = daySelect.value;

  if (!start || !end) return;

  document.querySelectorAll(".day-checkbox").forEach(label => {
    const checkbox = label.querySelector("input");
    const day = checkbox.value;

    // Disable current day
    if (day === currentDay) {
      checkbox.disabled = true;
      label.style.opacity = "0.5";
      label.classList.remove("has-clash");
      return;
    }

    checkbox.disabled = false;
    label.style.opacity = "1";

    const testClass = { day, start, end };
    const wouldClash = hasClash(testClass);
    label.classList.toggle("has-clash", wouldClash);
  });
}

// Copy to selected days
function handleCopyToDays() {
  const start = startTimeInput.value;
  const end = endTimeInput.value;
  const studentName = existingStudentSelect.value || studentNameInput.value.trim();

  if (!studentName || !start || !end) {
    alert("Please fill in student and time first");
    return;
  }

  const selectedDays = [];
  document.querySelectorAll(".day-checkbox input:checked").forEach(cb => {
    selectedDays.push(cb.value);
  });

  if (selectedDays.length === 0) {
    alert("Please select at least one day to copy to");
    return;
  }

  const weekStart = getWeekStartDate(currentWeekOffset);
  let addedCount = 0;
  let skippedCount = 0;

  selectedDays.forEach(day => {
    // Calculate date for target day
    const dayIndex = DAYS.indexOf(day);
    const targetDate = new Date(weekStart);
    targetDate.setDate(weekStart.getDate() + dayIndex);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    const newClass = {
      student: studentName,
      day,
      date: targetDateStr,
      start,
      end
    };

    if (!hasClash(newClass)) {
      classes.push(newClass);
      addedCount++;
    } else {
      skippedCount++;
    }
  });

  if (addedCount > 0) {
    saveClasses();
    renderWeekGrid();
    updateStudentDropdowns();
  }

  // Reset checkboxes
  document.querySelectorAll(".day-checkbox input").forEach(cb => {
    cb.checked = false;
  });

  showToast(`Copied to ${addedCount} day(s)${skippedCount > 0 ? `, ${skippedCount} skipped (clash)` : ''}`);
}

// Form Handling
function handleFormSubmit(e) {
  e.preventDefault();

  // Get student name from either dropdown or text input
  const studentName = existingStudentSelect.value || studentNameInput.value.trim();

  if (!studentName) {
    alert("Please select or enter a student name");
    return;
  }

  // Calculate the actual date for this class based on selected day and current week offset
  const weekStart = getWeekStartDate(currentWeekOffset);
  const dayIndex = DAYS.indexOf(daySelect.value);
  const classDate = new Date(weekStart);
  classDate.setDate(weekStart.getDate() + dayIndex);

  const cls = {
    student: studentName,
    day: daySelect.value,
    date: classDate.toISOString().split('T')[0], // YYYY-MM-DD format
    start: startTimeInput.value,
    end: endTimeInput.value
  };

  // Validate end time is after start time
  if (cls.end <= cls.start) {
    alert("End time must be after start time");
    return;
  }

  // Check for clashes (excluding current class if editing)
  if (hasClash(cls, editingIndex) && !allowClashOverride) {
    formClashWarning.classList.remove("hidden");
    showSuggestedSlots(cls.day);
    return;
  }

  // Mark class as having allowed clash if override was used
  if (allowClashOverride) {
    cls.allowedClash = true;
  }

  if (editingIndex !== null) {
    classes[editingIndex] = cls;
  } else {
    classes.push(cls);
  }

  saveClasses();
  closeModal();
  renderWeekGrid();
  updateStudentDropdowns();

  // Show toast if saved with clash
  if (allowClashOverride) {
    showToast("Class saved with time clash");
  }
}

// Handle Allow Clash button click
function handleAllowClash() {
  allowClashOverride = true;
  formClashWarning.classList.add("hidden");
  suggestedSlots.classList.add("hidden");

  // Trigger form submit
  classForm.dispatchEvent(new Event('submit', { cancelable: true }));
}

// Handle Check with Student - saves class as pending and sends WhatsApp
function handleCheckWithStudent() {
  // Get student name from either dropdown or text input
  const studentName = existingStudentSelect.value || studentNameInput.value.trim();

  if (!studentName) {
    alert("Please select or enter a student name");
    return;
  }

  const day = daySelect.value;
  const start = startTimeInput.value;
  const end = endTimeInput.value;

  if (!day || !start || !end) {
    alert("Please fill in all fields");
    return;
  }

  if (end <= start) {
    alert("End time must be after start time");
    return;
  }

  const cls = {
    student: studentName,
    day: day,
    start: start,
    end: end,
    pendingConfirmation: true,
    pendingSince: new Date().toISOString()
  };

  // Check for clashes
  if (hasClash(cls, editingIndex) && !allowClashOverride) {
    formClashWarning.classList.remove("hidden");
    showSuggestedSlots(cls.day);
    return;
  }

  // Mark class as having allowed clash if override was used
  if (allowClashOverride) {
    cls.allowedClash = true;
  }

  if (editingIndex !== null) {
    classes[editingIndex] = { ...classes[editingIndex], ...cls };
  } else {
    classes.push(cls);
  }

  saveClasses();

  // Send WhatsApp message
  sendWhatsAppConfirmation(cls);

  closeModal();
  renderWeekGrid();
  updateStudentDropdowns();
  showToast("WhatsApp opened - awaiting student confirmation");
}

// Send WhatsApp confirmation message
function sendWhatsAppConfirmation(cls) {
  const studentName = cls.student;
  const startTime = formatTime(cls.start);
  const endTime = formatTime(cls.end);

  // Get next occurrence of this day
  const nextDate = getNextDayDate(cls.day);
  const dateStr = nextDate.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short'
  });

  const message = `Hi ${studentName}! 📚

I'd like to schedule a class with you:

📅 *${dateStr}*
⏰ *${startTime} - ${endTime}*

Please confirm if this time works for you.
`;

  // Open WhatsApp with the message
  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://wa.me/?text=${encodedMessage}`;
  window.open(whatsappUrl, '_blank');
}

// Get the next occurrence of a day
function getNextDayDate(dayName) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = new Date();
  const todayDay = today.getDay();
  const targetDay = days.indexOf(dayName);

  let daysUntil = targetDay - todayDay;
  if (daysUntil <= 0) daysUntil += 7; // Next week if today or past

  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + daysUntil);
  return nextDate;
}

// Handle student confirmation
function handleConfirmClass() {
  if (editingIndex === null) return;

  const cls = classes[editingIndex];
  delete cls.pendingConfirmation;
  delete cls.pendingSince;

  saveClasses();
  closeModal();
  renderWeekGrid();
  showToast("Class confirmed! ✓");
}

// Handle resend WhatsApp
function handleResendWhatsApp() {
  if (editingIndex === null) return;

  const cls = classes[editingIndex];
  sendWhatsAppConfirmation(cls);
  showToast("WhatsApp opened");
}

function handleDelete() {
  if (editingIndex !== null && confirm("Are you sure you want to delete this class permanently?")) {
    classes.splice(editingIndex, 1);
    saveClasses();
    closeModal();
    renderWeekGrid();
    updateStudentDropdowns();
  }
}

function handleCancelClass(reason) {
  if (editingIndex === null) return;

  const cls = classes[editingIndex];

  if (reason === 'other') {
    const customReason = prompt("Enter cancellation reason:");
    if (!customReason) return;
    cls.customCancelReason = customReason;
  }

  cls.cancelled = true;
  cls.cancelReason = reason;
  cls.cancelledAt = new Date().toISOString();

  saveClasses();
  closeModal();
  renderWeekGrid();

  showToast(`Class cancelled: ${CANCEL_REASONS[reason]}`);
}

function handleRestoreClass() {
  if (editingIndex === null) return;

  const cls = classes[editingIndex];

  // Check if restoring would cause a clash
  const testClass = { ...cls, cancelled: false };
  delete testClass.cancelReason;
  delete testClass.cancelledAt;
  delete testClass.customCancelReason;

  // Check for clashes with other non-cancelled classes
  const wouldClash = classes.some((c, i) => {
    if (i === editingIndex) return false;
    if (c.cancelled) return false;
    return c.day === testClass.day && timesOverlap(testClass, c);
  });

  if (wouldClash) {
    alert("Cannot restore: This slot now has a time clash with another class.");
    return;
  }

  delete cls.cancelled;
  delete cls.cancelReason;
  delete cls.cancelledAt;
  delete cls.customCancelReason;

  saveClasses();
  closeModal();
  renderWeekGrid();

  showToast("Class restored successfully!");
}

// Handle notifying student about class cancellation via WhatsApp
function handleNotifyStudentCancellation() {
  if (editingIndex === null) return;

  const cls = classes[editingIndex];
  if (!cls.cancelled) return;

  const studentName = cls.student;
  const startTime = formatTime(cls.start);
  const endTime = formatTime(cls.end);

  // Get the date of this class
  let dateStr;
  if (cls.date) {
    const classDate = new Date(cls.date + 'T00:00:00');
    dateStr = classDate.toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short'
    });
  } else {
    const nextDate = getNextDayDate(cls.day);
    dateStr = nextDate.toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short'
    });
  }

  // Get cancellation reason
  let reasonText = '';
  if (cls.cancelReason === 'tutor') {
    reasonText = 'due to my unavailability';
  } else if (cls.cancelReason === 'holiday') {
    reasonText = 'due to a holiday';
  } else if (cls.cancelReason === 'other' && cls.customCancelReason) {
    reasonText = `due to: ${cls.customCancelReason}`;
  } else if (cls.cancelReason === 'student') {
    reasonText = 'as per your request';
  } else {
    reasonText = 'due to unforeseen circumstances';
  }

  const message = `Hi ${studentName}!

I'm sorry, but I need to cancel our scheduled class:

📅 *${dateStr}*
⏰ *${startTime} - ${endTime}*

This class has been cancelled ${reasonText}.

I'll reach out to reschedule soon. Sorry for any inconvenience!
`;

  // Open WhatsApp with the message
  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://wa.me/?text=${encodedMessage}`;
  window.open(whatsappUrl, '_blank');

  showToast("WhatsApp opened to notify student");
}

function handleDuplicate() {
  if (editingIndex === null) return;

  const originalClass = classes[editingIndex];

  // Close edit modal and open add modal with pre-filled data
  closeModal();

  // Small delay to allow modal to close
  setTimeout(() => {
    editingIndex = null;
    modalTitle.textContent = "Duplicate Class";
    deleteBtn.classList.add("hidden");
    duplicateBtn.classList.add("hidden");
    copyToDaySection.classList.remove("hidden");

    // Pre-fill with original class data
    updateStudentDropdowns();
    const studentExists = [...existingStudentSelect.options].some(opt => opt.value === originalClass.student);
    if (studentExists) {
      existingStudentSelect.value = originalClass.student;
      studentNameInput.value = "";
    } else {
      existingStudentSelect.value = "";
      studentNameInput.value = originalClass.student;
    }

    daySelect.value = originalClass.day;
    startTimeInput.value = originalClass.start;
    endTimeInput.value = originalClass.end;

    // Set duration
    const duration = getMinutesBetween(originalClass.start, originalClass.end);
    selectedDuration = duration;
    document.querySelectorAll(".duration-btn").forEach(btn => {
      btn.classList.toggle("active", parseInt(btn.dataset.minutes) === duration);
    });

    formClashWarning.classList.add("hidden");
    suggestedSlots.classList.add("hidden");
    updateQuickSlotsClashState();
    updateCopyToDayClashState();

    modal.classList.remove("hidden");
  }, 100);
}

// Clash Detection
function hasClash(newClass, excludeIndex = null) {
  return classes.some((c, i) => {
    if (excludeIndex !== null && i === excludeIndex) return false;
    if (c.cancelled) return false; // Cancelled classes don't cause clashes
    // Check by date if available, otherwise fall back to day name
    const sameDay = newClass.date ? c.date === newClass.date : c.day === newClass.day;
    return sameDay && timesOverlap(newClass, c);
  });
}

function checkFormClash() {
  const day = daySelect.value;
  const start = startTimeInput.value;
  const end = endTimeInput.value;

  if (!day || !start || !end) {
    formClashWarning.classList.add("hidden");
    suggestedSlots.classList.add("hidden");
    return;
  }

  // Calculate date for the selected day in current week
  const weekStart = getWeekStartDate(currentWeekOffset);
  const dayIndex = DAYS.indexOf(day);
  const classDate = new Date(weekStart);
  classDate.setDate(weekStart.getDate() + dayIndex);
  const dateStr = classDate.toISOString().split('T')[0];

  const testClass = { day, date: dateStr, start, end };

  if (hasClash(testClass, editingIndex)) {
    formClashWarning.classList.remove("hidden");
    showSuggestedSlots(day);
  } else {
    formClashWarning.classList.add("hidden");
    suggestedSlots.classList.add("hidden");
  }
}

// Auto-Suggest Available Slots
// Initialize slot chips event delegation (called once in setupEventListeners)
function initSlotChipsEventDelegation() {
  slotsList.addEventListener("click", (e) => {
    const chip = e.target.closest(".slot-chip");
    if (!chip) return;

    startTimeInput.value = chip.dataset.start;
    endTimeInput.value = chip.dataset.end;
    checkFormClash();
    updateQuickSlotsClashState();
    updateCopyToDayClashState();
  });
}

function showSuggestedSlots(day) {
  const availableSlots = findAvailableSlots(day);

  if (availableSlots.length === 0) {
    suggestedSlots.classList.add("hidden");
    return;
  }

  slotsList.innerHTML = availableSlots.map(slot => `
    <button type="button" class="slot-chip" data-start="${slot.start}" data-end="${slot.end}">
      ${formatTime(slot.start)} - ${formatTime(slot.end)}
    </button>
  `).join("");

  // Event listeners handled via delegation (initSlotChipsEventDelegation)

  suggestedSlots.classList.remove("hidden");
}

function findAvailableSlots(day) {
  const dayClasses = classes
    .filter(c => c.day === day)
    .sort((a, b) => a.start.localeCompare(b.start));

  const slots = [];
  let currentStart = `${String(WORKING_HOURS.start).padStart(2, '0')}:00`;
  const dayEnd = `${String(WORKING_HOURS.end).padStart(2, '0')}:00`;

  // If editing, exclude current class from consideration
  const relevantClasses = editingIndex !== null
    ? dayClasses.filter(c => classes.indexOf(c) !== editingIndex)
    : dayClasses;

  for (const cls of relevantClasses) {
    // Check if there's a gap before this class
    if (currentStart < cls.start) {
      const gapMinutes = getMinutesBetween(currentStart, cls.start);
      if (gapMinutes >= selectedDuration) {
        slots.push({
          start: currentStart,
          end: addMinutesToTime(currentStart, selectedDuration)
        });
      }
    }
    // Move current start to end of this class
    if (cls.end > currentStart) {
      currentStart = cls.end;
    }
  }

  // Check for slot at the end of the day
  if (currentStart < dayEnd) {
    const gapMinutes = getMinutesBetween(currentStart, dayEnd);
    if (gapMinutes >= selectedDuration) {
      slots.push({
        start: currentStart,
        end: addMinutesToTime(currentStart, selectedDuration)
      });
    }
  }

  return slots.slice(0, 4); // Return max 4 suggestions
}

// Student Dropdown Functions
function updateStudentDropdowns() {
  const students = [...new Set(classes.map(c => c.student))].sort();

  // Update main student view dropdown
  studentSelect.innerHTML = '<option value="">-- Choose Student --</option>';
  students.forEach(student => {
    const option = document.createElement("option");
    option.value = student;
    option.textContent = student;
    studentSelect.appendChild(option);
  });

  // Update form's existing student dropdown
  existingStudentSelect.innerHTML = '<option value="">-- Select Existing --</option>';
  students.forEach(student => {
    const option = document.createElement("option");
    option.value = student;
    option.textContent = student;
    existingStudentSelect.appendChild(option);
  });
}

function renderStudentSchedule() {
  const selectedStudent = studentSelect.value;

  if (!selectedStudent) {
    studentSchedule.innerHTML = '<p class="empty-state">Select a student to view their weekly schedule</p>';
    return;
  }

  const studentClasses = classes
    .filter(c => c.student === selectedStudent)
    .sort((a, b) => {
      const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
      if (dayDiff !== 0) return dayDiff;
      return a.start.localeCompare(b.start);
    });

  if (studentClasses.length === 0) {
    studentSchedule.innerHTML = '<p class="empty-state">No classes scheduled for this student</p>';
    return;
  }

  // Group by day
  const groupedByDay = {};
  DAYS.forEach(day => {
    const dayClasses = studentClasses.filter(c => c.day === day);
    if (dayClasses.length > 0) {
      groupedByDay[day] = dayClasses;
    }
  });

  let html = '';
  for (const day of DAYS) {
    if (groupedByDay[day]) {
      html += `
        <div class="student-day">
          <div class="student-day-header">${day}</div>
          ${groupedByDay[day].map(c => `
            <div class="student-class">
              <span class="student-class-time">${formatTime(c.start)} - ${formatTime(c.end)}</span>
              <span class="student-class-duration">${getDuration(c.start, c.end)}</span>
            </div>
          `).join("")}
        </div>
      `;
    }
  }

  studentSchedule.innerHTML = html;
}

// Utility Functions
function saveClasses() {
  localStorage.setItem("classes", JSON.stringify(classes));
  // Clear selection to prevent stale indices after class modifications
  selectedClasses.clear();
}

function formatTime(time24) {
  const [hours, minutes] = time24.split(":");
  const h = parseInt(hours);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${minutes} ${ampm}`;
}

function addMinutesToTime(time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

function getMinutesBetween(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function getDuration(start, end) {
  const minutes = getMinutesBetween(start, end);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Report Functions
function navigateReport(direction) {
  if (reportPeriod === 'custom') return; // No navigation for custom range
  reportOffset += direction;
  renderReport();
}

function getReportDateRange() {
  const now = new Date();
  let startDate, endDate, label;

  if (reportPeriod === 'week') {
    // Get current week (Monday to Sunday) with offset
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    startDate = new Date(now);
    startDate.setDate(now.getDate() + diff + (reportOffset * 7));
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    const dateRange = `${formatDateShort(startDate)} - ${formatDateShort(endDate)}`;
    if (reportOffset === 0) {
      label = `This Week (${dateRange})`;
    } else if (reportOffset === -1) {
      label = `Last Week (${dateRange})`;
    } else if (reportOffset === 1) {
      label = `Next Week (${dateRange})`;
    } else {
      label = `Week of ${formatDateLong(startDate)}`;
    }
  } else if (reportPeriod === 'month') {
    // Get month with offset
    startDate = new Date(now.getFullYear(), now.getMonth() + reportOffset, 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + reportOffset + 1, 0, 23, 59, 59, 999);

    const monthYear = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (reportOffset === 0) {
      label = `This Month (${monthYear})`;
    } else if (reportOffset === -1) {
      label = `Last Month (${monthYear})`;
    } else if (reportOffset === 1) {
      label = `Next Month (${monthYear})`;
    } else {
      label = monthYear;
    }
  } else if (reportPeriod === 'custom' && customStartDate && customEndDate) {
    startDate = new Date(customStartDate);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(customEndDate);
    endDate.setHours(23, 59, 59, 999);

    label = `${formatDateLong(startDate)} - ${formatDateLong(endDate)}`;
  } else {
    // Default to this week (fallback for invalid reportPeriod)
    reportPeriod = 'week';
    reportOffset = 0;
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    startDate = new Date(now);
    startDate.setDate(now.getDate() + diff);
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    label = `This Week`;
  }

  return { startDate, endDate, label };
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getClassesInRange(startDate, endDate) {
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  return classes.filter(cls => {
    if (!cls.date) return false;
    return cls.date >= startStr && cls.date <= endStr;
  });
}

// Generate unique ID for a class for payment tracking
function getClassPaymentId(cls) {
  // Create unique ID based on student, date, and time
  return `${cls.student}_${cls.date}_${cls.start}_${cls.end}`;
}

function renderReport() {
  const { startDate, endDate, label } = getReportDateRange();

  // Update period label
  document.getElementById("reportPeriodLabel").textContent = label;

  // Create a period key for payment tracking
  const periodKey = `${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}`;

  // Get classes in range (for now, all classes since we don't have date-specific data)
  const classesInRange = getClassesInRange(startDate, endDate);

  // Helper to check if a class is completed (day/time has passed)
  const today = new Date();
  const todayDayIndex = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const dayIndexMap = { 'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6 };

  function isClassCompleted(cls) {
    // If class has a completion date stored, use that
    if (cls.completedDate) return true;

    // Otherwise check if the day has passed this week
    const classDayIndex = dayIndexMap[cls.day];

    // If class day is before today in the week, it's completed
    // If class day is today, check if the class end time has passed
    if (classDayIndex < todayDayIndex) {
      return true;
    } else if (classDayIndex === todayDayIndex) {
      // Check if class end time has passed
      const now = new Date();
      const [endHour, endMin] = cls.end.split(':').map(Number);
      const classEndTime = new Date(now);
      classEndTime.setHours(endHour, endMin, 0, 0);
      return now > classEndTime;
    }
    return false;
  }

  // Calculate totals with proper completed/upcoming distinction
  let totalClasses = classesInRange.length;
  let cancelledCount = classesInRange.filter(c => c.cancelled).length;
  let pendingCount = classesInRange.filter(c => c.pendingConfirmation).length;
  let completedCount = 0;
  let upcomingCount = 0;
  let completedMinutes = 0;

  // Calculate completed vs upcoming for confirmed (non-cancelled, non-pending) classes
  classesInRange.forEach(c => {
    if (!c.cancelled && !c.pendingConfirmation) {
      if (isClassCompleted(c)) {
        completedCount++;
        completedMinutes += getMinutesBetween(c.start, c.end);
      } else {
        upcomingCount++;
      }
    }
  });

  const totalHours = (completedMinutes / 60).toFixed(1);

  // Update summary cards
  document.getElementById("totalClasses").textContent = totalClasses;
  document.getElementById("completedClasses").textContent = completedCount;
  document.getElementById("upcomingClasses").textContent = upcomingCount + pendingCount;
  document.getElementById("cancelledClasses").textContent = cancelledCount;
  document.getElementById("totalHours").textContent = totalHours;

  // Calculate per-student stats with individual class tracking
  const studentStats = {};
  classesInRange.forEach(c => {
    if (!studentStats[c.student]) {
      studentStats[c.student] = {
        total: 0,
        cancelled: 0,
        pending: 0,
        completed: 0,
        upcoming: 0,
        completedMinutes: 0,
        upcomingMinutes: 0,
        paidClasses: 0,
        paidMinutes: 0,
        completedClassIds: [] // Track individual completed class IDs
      };
    }
    studentStats[c.student].total++;
    if (c.cancelled) {
      studentStats[c.student].cancelled++;
    } else if (c.pendingConfirmation) {
      studentStats[c.student].pending++;
    } else {
      // Check if class is completed or upcoming
      const minutes = getMinutesBetween(c.start, c.end);
      if (isClassCompleted(c)) {
        studentStats[c.student].completed++;
        studentStats[c.student].completedMinutes += minutes;
        // Generate unique class ID for payment tracking
        const classId = getClassPaymentId(c);
        studentStats[c.student].completedClassIds.push(classId);
        // Check if this class is paid
        if (paymentStatus[classId]) {
          studentStats[c.student].paidClasses++;
          studentStats[c.student].paidMinutes += minutes;
        }
      } else {
        studentStats[c.student].upcoming++;
        studentStats[c.student].upcomingMinutes += minutes;
      }
    }
  });

  // Render table
  const tbody = document.getElementById("studentReportBody");
  const students = Object.keys(studentStats).sort();

  let totalAmount = 0;
  let paidAmount = 0;

  if (students.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #9ca3af; padding: 24px;">No classes found</td></tr>';
  } else {
    tbody.innerHTML = students.map(student => {
      const stats = studentStats[student];
      const completedClasses = stats.completed;
      const upcomingClasses = stats.upcoming;
      const paidClasses = stats.paidClasses;
      const unpaidClasses = completedClasses - paidClasses;
      const completedHours = (stats.completedMinutes / 60).toFixed(1);
      const rate = studentRates[student] || defaultRate;
      // Only calculate amount for completed classes
      const amount = Math.round((stats.completedMinutes / 60) * rate);
      const paidAmountForStudent = Math.round((stats.paidMinutes / 60) * rate);
      const unpaidAmount = amount - paidAmountForStudent;
      totalAmount += amount;
      paidAmount += paidAmountForStudent;

      // All classes paid?
      const allPaid = completedClasses > 0 && paidClasses === completedClasses;

      // Determine row class based on completed vs upcoming
      const hasCompletedClasses = completedClasses > 0;
      const hasUpcomingClasses = upcomingClasses > 0;
      const hasPendingClasses = stats.pending > 0;

      // Row color logic:
      // - Green: all completed classes are paid
      // - Light green: has completed but not all paid
      // - Amber: only upcoming or pending classes (no completed)
      // - Mixed (light yellow): has both completed and upcoming/pending
      let rowClass = '';
      if (!hasCompletedClasses && (hasUpcomingClasses || hasPendingClasses)) {
        rowClass = 'report-row-pending'; // Only upcoming/pending - amber
      } else if (hasCompletedClasses && (hasUpcomingClasses || hasPendingClasses)) {
        rowClass = 'report-row-mixed'; // Mix of completed and upcoming - light yellow
      } else if (hasCompletedClasses) {
        rowClass = allPaid ? 'report-row-paid' : 'report-row-confirmed'; // Green shades
      }

      // Build badges for upcoming and pending
      const badges = [];
      if (hasUpcomingClasses) badges.push(`${upcomingClasses} upcoming`);
      if (hasPendingClasses) badges.push(`${stats.pending} awaiting`);

      // Payment status display
      let paymentDisplay = '';
      if (hasCompletedClasses) {
        if (allPaid) {
          paymentDisplay = `<span class="payment-status paid">✓ All Paid (${paidClasses})</span>`;
        } else if (paidClasses > 0) {
          paymentDisplay = `
            <span class="payment-status partial">${paidClasses}/${completedClasses} Paid</span>
            <button class="mark-paid-btn" data-student="${escapeHtml(student)}" data-class-ids="${stats.completedClassIds.join(',')}" title="Mark classes as paid">
              Mark Paid
            </button>
          `;
        } else {
          paymentDisplay = `
            <span class="payment-status unpaid">${completedClasses} Unpaid</span>
            <button class="mark-paid-btn" data-student="${escapeHtml(student)}" data-class-ids="${stats.completedClassIds.join(',')}" title="Mark classes as paid">
              Mark Paid
            </button>
          `;
        }
      }

      return `
        <tr class="${rowClass}">
          <td>
            <strong>${escapeHtml(student)}</strong>
            ${badges.length > 0 ? `<span class="student-pending-badge">${badges.join(', ')}</span>` : ''}
          </td>
          <td>${completedClasses}${(hasUpcomingClasses || hasPendingClasses) ? ` <span class="pending-count">(+${upcomingClasses + stats.pending})</span>` : ''}</td>
          <td class="cancelled-count">${stats.cancelled > 0 ? stats.cancelled : '-'}</td>
          <td>${completedHours}</td>
          <td>
            <input type="number" class="student-rate-input"
                   data-student="${escapeHtml(student)}"
                   value="${rate}"
                   min="0" step="50" />
          </td>
          <td class="amount">${hasCompletedClasses ? `₹${amount.toLocaleString()}${unpaidAmount > 0 ? ` <span class="unpaid-amount">(₹${unpaidAmount.toLocaleString()} unpaid)</span>` : ''}` : '-'}</td>
          <td class="payment-cell">
            ${hasCompletedClasses ? `
              ${paymentDisplay}
              ${unpaidAmount > 0 ? `
                <button class="reminder-btn" data-student="${escapeHtml(student)}" data-amount="${unpaidAmount}" data-classes="${unpaidClasses}" data-hours="${(stats.completedMinutes - stats.paidMinutes) / 60}" title="Send payment reminder">
                  📩
                </button>
              ` : ''}
            ` : hasPendingClasses ? `
              <span class="awaiting-confirm-label">Awaiting confirmation</span>
            ` : `
              <span class="upcoming-label">Upcoming</span>
            `}
          </td>
        </tr>
      `;
    }).join('');

    // Add event listeners to rate inputs
    tbody.querySelectorAll('.student-rate-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const student = e.target.dataset.student;
        let newRate = parseInt(e.target.value);

        // Validate rate - must be non-negative
        if (isNaN(newRate) || newRate < 0) {
          newRate = 0;
          e.target.value = 0;
          showToast('Rate must be a positive number');
        }

        // Cap at reasonable maximum (100000)
        if (newRate > 100000) {
          newRate = 100000;
          e.target.value = 100000;
          showToast('Rate capped at maximum value');
        }

        studentRates[student] = newRate;
        localStorage.setItem('studentRates', JSON.stringify(studentRates));
        renderReport();
      });
    });

    // Add event listeners to "Mark Paid" buttons
    tbody.querySelectorAll('.mark-paid-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const student = e.target.dataset.student;
        const classIds = e.target.dataset.classIds.split(',');
        showMarkPaidDialog(student, classIds);
      });
    });

    // Add event listeners to reminder buttons
    tbody.querySelectorAll('.reminder-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const student = e.target.dataset.student;
        const amount = e.target.dataset.amount;
        const classCount = e.target.dataset.classes;
        const hours = e.target.dataset.hours;
        // Get the days this student has classes
        const studentClasses = classes.filter(c => c.student === student && !c.cancelled);
        const days = [...new Set(studentClasses.map(c => c.day))];
        sendPaymentReminder(student, amount, label, classCount, hours, days);
      });
    });
  }

  // Update footer totals
  document.getElementById("footerClasses").textContent = completedCount;
  document.getElementById("footerCancelled").textContent = cancelledCount;
  document.getElementById("footerHours").textContent = totalHours;
  document.getElementById("footerAmount").textContent = `₹${totalAmount.toLocaleString()}`;

  // Update payment summary in footer
  const pendingAmount = totalAmount - paidAmount;
  document.getElementById("footerPayment").innerHTML = pendingAmount > 0
    ? `<span class="pending-indicator">₹${pendingAmount.toLocaleString()} pending</span>`
    : '<span class="paid-indicator">All Paid ✓</span>';

  // Render earnings chart
  renderEarningsChart(classesInRange, studentStats, periodKey, isClassCompleted);
}

// Render earnings chart
function renderEarningsChart(classesInRange, _studentStats, periodKey, isClassCompleted) {
  const chartContainer = document.getElementById('earningsChart');
  if (!chartContainer) return;

  // Calculate per-day earnings
  const dayEarnings = {};
  const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Initialize all days
  dayOrder.forEach(day => {
    dayEarnings[day] = { paid: 0, completed: 0, upcoming: 0 };
  });

  // Calculate earnings for each class by day
  classesInRange.forEach(cls => {
    if (cls.cancelled) return;

    const rate = studentRates[cls.student] || defaultRate;
    const minutes = getMinutesBetween(cls.start, cls.end);
    const amount = Math.round((minutes / 60) * rate);

    if (cls.pendingConfirmation) {
      dayEarnings[cls.day].upcoming += amount;
    } else if (isClassCompleted(cls)) {
      // Check if this student's payment is marked as paid for this period
      const paymentKey = `${cls.student}_${periodKey}`;
      if (paymentStatus[paymentKey]) {
        dayEarnings[cls.day].paid += amount;
      } else {
        dayEarnings[cls.day].completed += amount;
      }
    } else {
      dayEarnings[cls.day].upcoming += amount;
    }
  });

  // Calculate totals for the chart header
  let totalPaid = 0, totalCompleted = 0, totalUpcoming = 0;
  dayOrder.forEach(day => {
    totalPaid += dayEarnings[day].paid;
    totalCompleted += dayEarnings[day].completed;
    totalUpcoming += dayEarnings[day].upcoming;
  });

  // Update chart header
  const totalEarned = totalPaid + totalCompleted;
  document.getElementById('chartTotalEarnings').textContent = `₹${totalEarned.toLocaleString()}`;
  document.getElementById('chartPendingEarnings').textContent =
    totalCompleted > 0 ? `(₹${totalCompleted.toLocaleString()} unpaid)` : '';

  // Find max for scaling
  const maxEarning = Math.max(
    ...dayOrder.map(day =>
      dayEarnings[day].paid + dayEarnings[day].completed + dayEarnings[day].upcoming
    ),
    100 // Minimum scale
  );

  // Render bars with interactive tooltips
  chartContainer.innerHTML = dayOrder.map(day => {
    const earnings = dayEarnings[day];
    const total = earnings.paid + earnings.completed + earnings.upcoming;
    const paidHeight = (earnings.paid / maxEarning) * 100;
    const completedHeight = (earnings.completed / maxEarning) * 100;
    const upcomingHeight = (earnings.upcoming / maxEarning) * 100;

    // Determine today for highlighting
    const today = new Date();
    const dayIndex = { 'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6 };
    const isToday = dayIndex[day] === today.getDay();

    // Build tooltip content
    const tooltipLines = [];
    if (earnings.paid > 0) tooltipLines.push(`Paid: ₹${earnings.paid.toLocaleString()}`);
    if (earnings.completed > 0) tooltipLines.push(`Unpaid: ₹${earnings.completed.toLocaleString()}`);
    if (earnings.upcoming > 0) tooltipLines.push(`Upcoming: ₹${earnings.upcoming.toLocaleString()}`);
    const tooltipContent = tooltipLines.length > 0 ? tooltipLines.join(' | ') : 'No classes';

    return `
      <div class="chart-bar-group ${isToday ? 'today' : ''}" data-day="${day}">
        <div class="chart-bar-stack"
             data-total="${total}"
             data-paid="${earnings.paid}"
             data-completed="${earnings.completed}"
             data-upcoming="${earnings.upcoming}">
          ${earnings.upcoming > 0 ? `<div class="chart-bar upcoming" style="height: ${upcomingHeight}%" data-amount="${earnings.upcoming}"></div>` : ''}
          ${earnings.completed > 0 ? `<div class="chart-bar completed" style="height: ${completedHeight}%" data-amount="${earnings.completed}"></div>` : ''}
          ${earnings.paid > 0 ? `<div class="chart-bar paid" style="height: ${paidHeight}%" data-amount="${earnings.paid}"></div>` : ''}
          ${total === 0 ? '<div class="chart-bar empty"></div>' : ''}
        </div>
        <div class="chart-tooltip">${tooltipContent}</div>
        <div class="chart-bar-label">${day.substring(0, 3)}</div>
        <div class="chart-bar-amount">${total > 0 ? `₹${total.toLocaleString()}` : '-'}</div>
      </div>
    `;
  }).join('');

  // Add click handlers for chart bars
  chartContainer.querySelectorAll('.chart-bar-group').forEach(group => {
    group.addEventListener('click', () => {
      const day = group.dataset.day;
      const stack = group.querySelector('.chart-bar-stack');
      const paid = parseInt(stack.dataset.paid) || 0;
      const completed = parseInt(stack.dataset.completed) || 0;
      const upcoming = parseInt(stack.dataset.upcoming) || 0;
      const total = paid + completed + upcoming;

      if (total > 0) {
        showChartDayDetails(day, paid, completed, upcoming, classesInRange, isClassCompleted, periodKey);
      }
    });
  });
}

// Show detailed breakdown for a day when clicked
function showChartDayDetails(day, paid, completed, upcoming, classesInRange, isClassCompleted, periodKey) {
  const dayClasses = classesInRange.filter(c => c.day === day && !c.cancelled);

  let detailsHtml = `<div class="chart-details-popup">
    <div class="chart-details-header">
      <h4>${day}</h4>
      <button class="chart-details-close">&times;</button>
    </div>
    <div class="chart-details-summary">
      ${paid > 0 ? `<span class="detail-paid">Paid: ₹${paid.toLocaleString()}</span>` : ''}
      ${completed > 0 ? `<span class="detail-completed">Unpaid: ₹${completed.toLocaleString()}</span>` : ''}
      ${upcoming > 0 ? `<span class="detail-upcoming">Upcoming: ₹${upcoming.toLocaleString()}</span>` : ''}
    </div>
    <div class="chart-details-classes">`;

  dayClasses.sort((a, b) => a.start.localeCompare(b.start)).forEach(cls => {
    const rate = studentRates[cls.student] || defaultRate;
    const minutes = getMinutesBetween(cls.start, cls.end);
    const amount = Math.round((minutes / 60) * rate);

    let status = 'upcoming';
    let statusLabel = 'Upcoming';
    if (cls.pendingConfirmation) {
      status = 'pending';
      statusLabel = 'Awaiting';
    } else if (isClassCompleted(cls)) {
      const paymentKey = `${cls.student}_${periodKey}`;
      if (paymentStatus[paymentKey]) {
        status = 'paid';
        statusLabel = 'Paid';
      } else {
        status = 'completed';
        statusLabel = 'Unpaid';
      }
    }

    detailsHtml += `
      <div class="chart-class-item ${status}">
        <div class="chart-class-info">
          <span class="chart-class-student">${escapeHtml(cls.student)}</span>
          <span class="chart-class-time">${formatTime(cls.start)} - ${formatTime(cls.end)}</span>
        </div>
        <div class="chart-class-amount">
          <span class="chart-class-status ${status}">${statusLabel}</span>
          <span>₹${amount.toLocaleString()}</span>
        </div>
      </div>`;
  });

  detailsHtml += `</div></div>`;

  // Remove any existing popup
  const existingPopup = document.querySelector('.chart-details-popup');
  if (existingPopup) existingPopup.remove();

  // Add new popup
  const chartContainer = document.querySelector('.earnings-chart-container');
  chartContainer.insertAdjacentHTML('beforeend', detailsHtml);

  // Add event listener for close button (inline onclick doesn't work for dynamically inserted HTML)
  const closeBtn = chartContainer.querySelector('.chart-details-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      const popup = document.querySelector('.chart-details-popup');
      if (popup) popup.remove();
    });
  }
}

// Show dialog to mark individual classes as paid
function showMarkPaidDialog(student, classIds) {
  // Find the actual class details for each class ID
  const classDetails = classIds.map(classId => {
    const parts = classId.split('_');
    // Format: student_date_start_end
    const date = parts[1];
    const start = parts[2];
    const end = parts[3];
    const isPaid = paymentStatus[classId] || false;
    const rate = studentRates[student] || defaultRate;
    const minutes = getMinutesBetween(start, end);
    const amount = Math.round((minutes / 60) * rate);

    // Format date nicely
    const dateObj = new Date(date + 'T00:00:00');
    const dateStr = dateObj.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

    return { classId, date, dateStr, start, end, isPaid, amount };
  });

  // Sort by date
  classDetails.sort((a, b) => a.date.localeCompare(b.date));

  const dialogHtml = `
    <div class="mark-paid-dialog-content">
      <h3>Mark Classes Paid - ${escapeHtml(student)}</h3>
      <p class="dialog-subtitle">Select the classes that have been paid for:</p>
      <div class="class-payment-list">
        ${classDetails.map(cls => `
          <label class="class-payment-item ${cls.isPaid ? 'paid' : ''}">
            <input type="checkbox" class="class-paid-checkbox" data-class-id="${cls.classId}" ${cls.isPaid ? 'checked' : ''} />
            <span class="class-info">
              <span class="class-date">${cls.dateStr}</span>
              <span class="class-time">${formatTime(cls.start)} - ${formatTime(cls.end)}</span>
            </span>
            <span class="class-amount">₹${cls.amount.toLocaleString()}</span>
          </label>
        `).join('')}
      </div>
      <div class="dialog-actions">
        <button class="btn btn-secondary" id="markAllPaidBtn">Mark All Paid</button>
        <button class="btn btn-primary" id="savePaymentBtn">Save</button>
        <button class="btn btn-secondary" id="cancelPaymentBtn">Cancel</button>
      </div>
    </div>
  `;

  // Create dialog overlay
  const dialog = document.createElement('div');
  dialog.id = 'markPaidDialog';
  dialog.className = 'modal';
  dialog.innerHTML = `<div class="modal-content">${dialogHtml}</div>`;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeMarkPaidDialog();
  });
  document.body.appendChild(dialog);

  // Event listeners
  document.getElementById('markAllPaidBtn').addEventListener('click', () => {
    dialog.querySelectorAll('.class-paid-checkbox').forEach(cb => {
      cb.checked = true;
      cb.closest('.class-payment-item').classList.add('paid');
    });
  });

  document.getElementById('savePaymentBtn').addEventListener('click', () => {
    let newPaymentsCount = 0;
    dialog.querySelectorAll('.class-paid-checkbox').forEach(cb => {
      const classId = cb.dataset.classId;
      const wasChecked = paymentStatus[classId];
      paymentStatus[classId] = cb.checked;
      if (cb.checked && !wasChecked) newPaymentsCount++;
    });
    localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
    closeMarkPaidDialog();

    // Celebrate if new payments were marked
    if (newPaymentsCount > 0) {
      celebratePayment();
    }

    renderReport();
  });

  document.getElementById('cancelPaymentBtn').addEventListener('click', closeMarkPaidDialog);

  // Update visual state when checkbox changes
  dialog.querySelectorAll('.class-paid-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        e.target.closest('.class-payment-item').classList.add('paid');
      } else {
        e.target.closest('.class-payment-item').classList.remove('paid');
      }
    });
  });
}

function closeMarkPaidDialog() {
  const dialog = document.getElementById('markPaidDialog');
  if (dialog) dialog.remove();
}

// Send payment reminder
function sendPaymentReminder(student, amount, period, classCount, hours, days) {
  // Format days nicely
  const daysText = days.length > 0 ? days.join(', ') : '';

  const message = `Hi! 🙏 Hope you're doing well!

Just a gentle reminder about ${student}'s tuition fees:
📅 ${period}
📚 ${classCount} class${classCount > 1 ? 'es' : ''} (${hours} hrs) - ${daysText}
*₹${parseInt(amount).toLocaleString()}*

Let me know if you have any questions.
`;

  // Check if Web Share API is available (mostly on mobile)
  if (navigator.share) {
    navigator.share({
      title: 'Payment Reminder',
      text: message
    }).catch(() => {
      // User cancelled or share failed, fallback to copy
      copyReminderToClipboard(message, student);
    });
  } else {
    // Fallback: offer WhatsApp or copy options
    const choice = prompt(
      `Send reminder to ${student}'s parent:\n\n` +
      `1 - Open WhatsApp (if you have their number)\n` +
      `2 - Copy message to clipboard\n\n` +
      `Enter 1 or 2:`
    );

    if (choice === '1') {
      // Open WhatsApp with pre-filled message
      const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
      window.open(whatsappUrl, '_blank');
    } else if (choice === '2') {
      copyReminderToClipboard(message, student);
    }
  }
}

function copyReminderToClipboard(message, student) {
  navigator.clipboard.writeText(message).then(() => {
    showToast(`Reminder copied! Paste and send to ${student}'s parent`);
  }).catch(() => {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = message;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast(`Reminder copied! Paste and send to ${student}'s parent`);
  });
}

// ==================== BACKUP FUNCTIONS ====================

// Check and create automatic backup (weekly)
function checkAndCreateBackup() {
  const lastBackupDate = localStorage.getItem('lastBackupDate');
  const now = new Date();
  const daysSinceBackup = lastBackupDate
    ? Math.floor((now - new Date(lastBackupDate)) / (1000 * 60 * 60 * 24))
    : 999;

  // Create backup if more than 7 days since last backup
  if (daysSinceBackup >= 7) {
    createAutoBackup();
  }
}

// Create automatic backup
function createAutoBackup() {
  const backupData = {
    timestamp: new Date().toISOString(),
    classes: classes,
    studentRates: studentRates,
    paymentStatus: paymentStatus,
    defaultRate: defaultRate
  };

  // Get existing backups
  let backups = safeJsonParse('autoBackups', []);

  // Add new backup
  backups.unshift(backupData);

  // Keep only last 4 backups
  backups = backups.slice(0, 4);

  localStorage.setItem('autoBackups', JSON.stringify(backups));
  localStorage.setItem('lastBackupDate', new Date().toISOString());
}

// Export data to JSON file
function exportData() {
  const exportData = {
    exportDate: new Date().toISOString(),
    version: '3.0', // v3.0: Added date field to classes for proper week/month tracking
    data: {
      classes: classes,
      studentRates: studentRates,
      paymentStatus: paymentStatus,
      defaultRate: defaultRate
    }
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mindful-maths-backup-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Backup downloaded successfully!');
}

// Import data from JSON file
function importData(file) {
  const reader = new FileReader();

  reader.onload = function(e) {
    try {
      const importedData = JSON.parse(e.target.result);

      // Validate the data structure
      if (!importedData.data || !importedData.data.classes) {
        throw new Error('Invalid backup file format');
      }

      // Confirm before overwriting
      if (confirm(`This will replace all current data with the backup from ${new Date(importedData.exportDate).toLocaleDateString()}. Continue?`)) {
        // Import the data
        classes = importedData.data.classes || [];
        studentRates = importedData.data.studentRates || {};
        paymentStatus = importedData.data.paymentStatus || {};
        defaultRate = importedData.data.defaultRate || 500;

        // Save to localStorage
        saveClasses();
        localStorage.setItem('studentRates', JSON.stringify(studentRates));
        localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
        localStorage.setItem('defaultRate', defaultRate);

        // Migrate imported classes to include date field if missing
        migrateClassesToDateFormat();

        // Refresh UI
        renderWeekGrid();
        updateStudentDropdowns();
        renderReport();

        showToast('Data restored successfully!');
      }
    } catch (error) {
      showToast('Error: Invalid backup file');
      console.error('Import error:', error);
    }
  };

  // Handle file read errors
  reader.onerror = function() {
    showToast('Error: Could not read the file');
    console.error('FileReader error:', reader.error);
  };

  reader.readAsText(file);
}

// Show backup/restore dialog
function showBackupDialog() {
  const backups = safeJsonParse('autoBackups', []);

  let backupListHtml = '';
  if (backups.length > 0) {
    backupListHtml = backups.map((backup, index) => {
      const date = new Date(backup.timestamp);
      return `<button class="backup-item" data-backup-index="${index}">
        ${date.toLocaleDateString()} ${date.toLocaleTimeString()}
        (${backup.classes ? backup.classes.length : 0} classes)
      </button>`;
    }).join('');
  } else {
    backupListHtml = '<p class="empty-state">No automatic backups yet</p>';
  }

  const dialogHtml = `
    <div class="backup-dialog-content">
      <h3>Data Backup & Restore</h3>

      <div class="backup-section">
        <h4>Export Data</h4>
        <p>Download a backup file to your device</p>
        <button class="btn btn-primary" id="exportDataBtn">Download Backup</button>
      </div>

      <div class="backup-section">
        <h4>Import Data</h4>
        <p>Restore from a backup file</p>
        <input type="file" id="importFile" accept=".json" style="display:none" />
        <button class="btn btn-secondary" id="chooseFileBtn">Choose Backup File</button>
      </div>

      <div class="backup-section">
        <h4>Auto Backups (Last 4 weeks)</h4>
        <div class="backup-list" id="backupList">
          ${backupListHtml}
        </div>
      </div>

      <button class="btn btn-secondary" id="closeBackupBtn" style="margin-top: 16px;">Close</button>
    </div>
  `;

  // Create dialog overlay
  const dialog = document.createElement('div');
  dialog.id = 'backupDialog';
  dialog.className = 'modal';
  dialog.innerHTML = `<div class="modal-content">${dialogHtml}</div>`;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeBackupDialog();
  });
  document.body.appendChild(dialog);

  // Add event listeners (CSP-compliant - no inline onclick)
  document.getElementById('exportDataBtn').addEventListener('click', exportData);
  document.getElementById('chooseFileBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', handleImportFile);
  document.getElementById('closeBackupBtn').addEventListener('click', closeBackupDialog);

  // Event delegation for backup items
  document.getElementById('backupList').addEventListener('click', (e) => {
    const backupItem = e.target.closest('.backup-item');
    if (backupItem && backupItem.dataset.backupIndex !== undefined) {
      restoreAutoBackup(parseInt(backupItem.dataset.backupIndex));
    }
  });
}

function closeBackupDialog() {
  const dialog = document.getElementById('backupDialog');
  if (dialog) dialog.remove();
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (file) {
    importData(file);
    closeBackupDialog();
  }
}

// Restore from auto backup
function restoreAutoBackup(index) {
  const backups = safeJsonParse('autoBackups', []);

  // Validate index bounds
  if (index < 0 || index >= backups.length) {
    showToast('Error: Invalid backup selection');
    return;
  }

  const backup = backups[index];
  if (!backup) return;

  const date = new Date(backup.timestamp);
  if (confirm(`Restore backup from ${date.toLocaleDateString()} ${date.toLocaleTimeString()}? This will replace all current data.`)) {
    classes = backup.classes || [];
    studentRates = backup.studentRates || {};
    paymentStatus = backup.paymentStatus || {};
    defaultRate = backup.defaultRate || 500;

    // Save to localStorage
    saveClasses();
    localStorage.setItem('studentRates', JSON.stringify(studentRates));
    localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
    localStorage.setItem('defaultRate', defaultRate);

    // Migrate imported classes to include date field if missing
    migrateClassesToDateFormat();

    // Refresh UI
    renderWeekGrid();
    updateStudentDropdowns();
    renderReport();

    closeBackupDialog();
    showToast('Data restored successfully!');
  }
}

// ==================== NOTIFICATION FUNCTIONS ====================

let notificationsEnabled = localStorage.getItem('notificationsEnabled') === 'true';
let notifiedClasses = new Set(); // Track which classes we've already notified about

// Initialize notifications
function initNotifications() {
  // Check if notifications are supported
  if (!('Notification' in window)) {
    console.log('Notifications not supported');
    return;
  }

  // Check current permission and restore saved preference
  if (Notification.permission === 'granted') {
    // Only enable if user previously enabled (or first time)
    const savedPref = localStorage.getItem('notificationsEnabled');
    if (savedPref === null || savedPref === 'true') {
      notificationsEnabled = true;
      localStorage.setItem('notificationsEnabled', 'true');
    }
    updateNotificationButton();
  } else if (Notification.permission !== 'denied') {
    // Show a prompt to enable notifications
    showNotificationPrompt();
  } else {
    // Permission denied, disable notifications
    notificationsEnabled = false;
    localStorage.setItem('notificationsEnabled', 'false');
  }

  // Load notified classes from session
  const stored = sessionStorage.getItem('notifiedClasses');
  if (stored) {
    notifiedClasses = new Set(JSON.parse(stored));
  }
}

// Test notification - to verify notifications are working
function testNotification() {
  if (!('Notification' in window)) {
    showInAppAlert('Test', 'Notifications not supported on this device');
    return;
  }

  if (Notification.permission !== 'granted') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        notificationsEnabled = true;
        localStorage.setItem('notificationsEnabled', 'true');
        updateNotificationButton();
        sendTestNotification();
      } else {
        localStorage.setItem('notificationsEnabled', 'false');
        showInAppAlert('Permission Denied', 'Please enable notifications in your browser/device settings');
      }
    });
  } else {
    sendTestNotification();
  }
}

function sendTestNotification() {
  const options = {
    body: 'You will receive reminders 15 min before each class.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'test-notification',
    requireInteraction: false,
    vibrate: [200, 100, 200]
  };

  // Use Service Worker for PWA notifications
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(registration => {
      registration.showNotification('Test Notification', options)
        .then(() => {
          showToast('Test notification sent!');
        })
        .catch(error => {
          console.error('SW notification error:', error);
          showInAppAlert('Notification Error', 'Could not send notification: ' + error.message);
        });
    });
  } else {
    // Fallback for regular browser
    try {
      const notification = new Notification('Test Notification', options);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      setTimeout(() => notification.close(), 5000);
      showToast('Test notification sent!');
    } catch (error) {
      console.error('Test notification error:', error);
      showInAppAlert('Notification Error', 'Could not send notification: ' + error.message);
    }
  }
}

// Show notification permission prompt
function showNotificationPrompt() {
  // Only show once per session
  if (sessionStorage.getItem('notificationPromptShown')) return;

  setTimeout(() => {
    if (confirm('Enable class reminders? You\'ll get a notification 15 minutes before each class.')) {
      requestNotificationPermission();
    }
    sessionStorage.setItem('notificationPromptShown', 'true');
  }, 2000);
}

// Request notification permission
function requestNotificationPermission() {
  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      notificationsEnabled = true;
      localStorage.setItem('notificationsEnabled', 'true');
      updateNotificationButton();
      showToast('Notifications enabled!');
    } else {
      localStorage.setItem('notificationsEnabled', 'false');
    }
  });
}

// Start checking for upcoming classes
function startClassReminderCheck() {
  // Check immediately
  checkUpcomingClasses();

  // Then check every minute
  setInterval(checkUpcomingClasses, 60000);
}

// Check for classes starting in 15 minutes
function checkUpcomingClasses() {
  if (!notificationsEnabled) return;

  const now = new Date();
  const currentDay = DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1]; // Convert to our day format
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // Get today's confirmed classes (exclude cancelled and pending confirmation)
  const todayClasses = classes.filter(c => c.day === currentDay && !c.cancelled && !c.pendingConfirmation);

  todayClasses.forEach(c => {
    const [hours, minutes] = c.start.split(':').map(Number);
    const classMinutes = hours * 60 + minutes;
    const minutesUntilClass = classMinutes - currentMinutes;

    // Create unique ID for this class instance (day + time + student)
    const classId = `${currentDay}-${c.start}-${c.student}`;

    // Notify if class is 14-16 minutes away (to handle minute boundaries)
    if (minutesUntilClass >= 14 && minutesUntilClass <= 16 && !notifiedClasses.has(classId)) {
      sendClassReminder(c);
      notifiedClasses.add(classId);
      sessionStorage.setItem('notifiedClasses', JSON.stringify([...notifiedClasses]));
    }
  });

  // Clear old notifications at midnight
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    notifiedClasses.clear();
    sessionStorage.removeItem('notifiedClasses');
  }
}

// Send class reminder notification
function sendClassReminder(classData) {
  if (!notificationsEnabled) return;

  // Show non-blocking toast instead of modal alert (so multiple can stack)
  showReminderToast(
    `${classData.student}'s class`,
    `${formatTime(classData.start)} - ${formatTime(classData.end)}`
  );

  // Use unique tag with timestamp to prevent notifications replacing each other
  const uniqueTag = `class-${classData.student}-${classData.start}-${Date.now()}`;

  // PWA notification options
  const options = {
    body: `⏰ ${formatTime(classData.start)} - ${formatTime(classData.end)}\nGet ready!`,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: uniqueTag,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300], // Longer vibration pattern
    actions: [
      { action: 'view', title: '📅 View Schedule' },
      { action: 'dismiss', title: '✓ Got it' }
    ],
    renotify: true,
    silent: false,
    // These help with heads-up display on Android
    urgency: 'high',
    priority: 'high'
  };

  const title = `🔔 ${classData.student}'s class in 15 min!`;

  // Use Service Worker for PWA notifications
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(registration => {
      registration.showNotification(title, options)
        .catch(error => console.error('SW notification error:', error));
    });
  } else {
    // Fallback for regular browser
    try {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      setTimeout(() => notification.close(), 300000);
    } catch (error) {
      console.error('Notification error:', error);
    }
  }
}

// Non-blocking toast notification for class reminders
function showReminderToast(title, message) {
  const toast = document.createElement('div');
  toast.className = 'reminder-toast';
  toast.innerHTML = `
    <div class="reminder-toast-icon">🔔</div>
    <div class="reminder-toast-content">
      <div class="reminder-toast-title">${escapeHtml(title)}</div>
      <div class="reminder-toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="reminder-toast-close">✕</button>
  `;

  // Add event listener for close button (CSP-compliant)
  toast.querySelector('.reminder-toast-close').addEventListener('click', () => {
    toast.remove();
  });

  // Add to container (create if doesn't exist)
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  container.appendChild(toast);

  // Animate in
  setTimeout(() => toast.classList.add('show'), 10);

  // Auto-remove after 15 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 15000);
}

// Toggle notifications - now shows a menu with options
function toggleNotifications() {
  const choice = prompt(
    `Notification Settings:\n\n` +
    `1 - ${notificationsEnabled ? 'Disable' : 'Enable'} notifications\n` +
    `2 - Test notification\n` +
    `3 - Check next upcoming class\n` +
    `4 - Cancel\n\n` +
    `Enter 1, 2, 3, or 4:`
  );

  if (choice === '1') {
    if (notificationsEnabled) {
      notificationsEnabled = false;
      localStorage.setItem('notificationsEnabled', 'false');
      updateNotificationButton();
      showToast('Notifications disabled');
    } else {
      if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        localStorage.setItem('notificationsEnabled', 'true');
        updateNotificationButton();
        showToast('Notifications enabled');
      } else {
        requestNotificationPermission();
      }
    }
  } else if (choice === '2') {
    testNotification();
  } else if (choice === '3') {
    showNextClassInfo();
  }
}

// Show next class info (for debugging)
function showNextClassInfo() {
  const now = new Date();
  const currentDay = DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const todayClasses = classes
    .filter(c => c.day === currentDay && !c.cancelled && !c.pendingConfirmation)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (todayClasses.length === 0) {
    showInAppAlert('No Classes Today', `Today is ${currentDay}. No classes scheduled.`);
    return;
  }

  // Find next upcoming class
  let nextClass = null;
  for (const c of todayClasses) {
    const [hours, minutes] = c.start.split(':').map(Number);
    const classMinutes = hours * 60 + minutes;
    if (classMinutes > currentMinutes) {
      nextClass = c;
      break;
    }
  }

  if (nextClass) {
    const [hours, minutes] = nextClass.start.split(':').map(Number);
    const classMinutes = hours * 60 + minutes;
    const minutesUntil = classMinutes - currentMinutes;
    showInAppAlert('Next Class',
      `${nextClass.student} at ${formatTime(nextClass.start)}\n` +
      `In ${minutesUntil} minutes\n` +
      `(Reminder at ${minutesUntil - 15} min remaining)`
    );
  } else {
    showInAppAlert('All Done', `All ${todayClasses.length} class(es) for today have passed.`);
  }
}

// Show in-app alert (visible fallback for notifications)
function showInAppAlert(title, message) {
  // Remove any existing alert
  const existing = document.querySelector('.in-app-alert');
  if (existing) existing.remove();

  const alert = document.createElement('div');
  alert.className = 'in-app-alert';
  alert.innerHTML = `
    <div class="in-app-alert-content">
      <div class="in-app-alert-title">${escapeHtml(title)}</div>
      <div class="in-app-alert-message">${escapeHtml(message)}</div>
      <button class="in-app-alert-close">OK</button>
    </div>
  `;

  // Add event listener for close button (CSP-compliant)
  alert.querySelector('.in-app-alert-close').addEventListener('click', () => {
    alert.remove();
  });

  document.body.appendChild(alert);

  // Auto-close after 10 seconds
  setTimeout(() => {
    if (alert.parentElement) alert.remove();
  }, 10000);
}

// Update notification button appearance
function updateNotificationButton() {
  const btn = document.getElementById('notificationBtn');
  if (btn) {
    if (notificationsEnabled) {
      btn.classList.add('notification-active');
      btn.title = 'Notifications ON - Click to disable';
    } else {
      btn.classList.remove('notification-active');
      btn.title = 'Notifications OFF - Click to enable';
    }
  }
}

// ==================== CELEBRATIONS & ACHIEVEMENTS ====================

// Badge definitions
const BADGES = {
  firstClass: { icon: '🎓', name: 'First Class', description: 'Schedule your first class' },
  tenClasses: { icon: '📚', name: '10 Classes', description: 'Complete 10 classes' },
  fiftyClasses: { icon: '🌟', name: '50 Classes', description: 'Complete 50 classes' },
  hundredClasses: { icon: '💯', name: '100 Classes', description: 'Complete 100 classes' },
  firstPayment: { icon: '💰', name: 'First Payment', description: 'Mark your first payment received' },
  tenPayments: { icon: '💎', name: '10 Payments', description: 'Receive 10 payments' },
  firstStudent: { icon: '👋', name: 'First Student', description: 'Add your first student' },
  fiveStudents: { icon: '👥', name: '5 Students', description: 'Have 5 active students' },
  streak3: { icon: '🔥', name: '3-Day Streak', description: 'Use the app 3 days in a row' },
  streak7: { icon: '⚡', name: 'Week Warrior', description: 'Use the app 7 days in a row' },
  streak30: { icon: '🏆', name: 'Monthly Master', description: 'Use the app 30 days in a row' },
  earlyBird: { icon: '🐦', name: 'Early Bird', description: 'Schedule a class before 8 AM' },
  nightOwl: { icon: '🦉', name: 'Night Owl', description: 'Schedule a class after 8 PM' },
  perfectWeek: { icon: '✨', name: 'Perfect Week', description: 'Complete all scheduled classes in a week' },
  thousand: { icon: '🎉', name: '₹1000 Earned', description: 'Earn your first ₹1000' },
  tenThousand: { icon: '🚀', name: '₹10,000 Earned', description: 'Earn ₹10,000 total' }
};

// Achievements state
let achievements = safeJsonParse('achievements', {
  badges: [],
  streak: 0,
  lastActiveDate: null,
  totalClassesCompleted: 0,
  totalPaymentsReceived: 0,
  totalEarnings: 0
});

// Flag to suppress celebrations during initial load
let celebrationsInitialized = false;

// Initialize celebrations system
function initCelebrations() {
  // Update streak on app load
  updateStreak();

  // Update header streak badge
  updateHeaderStreakBadge();

  // Setup event listeners
  document.getElementById('achievementsBtn').addEventListener('click', function() {
    console.log('Achievements button clicked');
    showAchievementsModal();
  });

  document.getElementById('closeAchievements').addEventListener('click', function() {
    console.log('Close achievements button clicked');
    closeAchievementsModal();
  });

  document.getElementById('achievementsModal').addEventListener('click', (e) => {
    if (e.target.id === 'achievementsModal') {
      console.log('Modal backdrop clicked');
      closeAchievementsModal();
    }
  });

  // Check for badges silently on init (don't show popups)
  checkAllBadges(true);

  // After init, enable celebrations
  celebrationsInitialized = true;

  console.log('Celebrations initialized. Streak:', achievements.streak, 'Badges:', achievements.badges);

  // Auto-show achievements modal on app load (brief flash)
  setTimeout(() => {
    showAchievementsModal();
  }, 500);
}

// Confetti Animation
function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  const ctx = canvas.getContext('2d');

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const confettiPieces = [];
  const colors = ['#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];

  // Create confetti pieces
  for (let i = 0; i < 150; i++) {
    confettiPieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 5,
      h: Math.random() * 6 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      velocity: Math.random() * 3 + 2,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.2
    });
  }

  let animationFrame;
  const startTime = Date.now();
  const duration = 3000; // 3 seconds

  function animate() {
    const elapsed = Date.now() - startTime;

    if (elapsed > duration) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animationFrame);
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    confettiPieces.forEach(piece => {
      piece.y += piece.velocity;
      piece.angle += piece.spin;

      ctx.save();
      ctx.translate(piece.x + piece.w / 2, piece.y + piece.h / 2);
      ctx.rotate(piece.angle);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      ctx.restore();

      // Reset if off screen
      if (piece.y > canvas.height) {
        piece.y = -20;
        piece.x = Math.random() * canvas.width;
      }
    });

    animationFrame = requestAnimationFrame(animate);
  }

  animate();
}

// Update streak
function updateStreak() {
  const today = new Date().toISOString().split('T')[0];
  const lastActive = achievements.lastActiveDate;

  console.log('Updating streak. Today:', today, 'Last active:', lastActive, 'Current streak:', achievements.streak);

  if (!lastActive) {
    // First time using app
    achievements.streak = 1;
    achievements.lastActiveDate = today;
    console.log('First time user - streak set to 1');
  } else if (lastActive === today) {
    // Already counted today - do nothing but ensure streak is at least 1
    if (achievements.streak < 1) achievements.streak = 1;
    console.log('Already active today - streak unchanged:', achievements.streak);
    return;
  } else {
    const lastDate = new Date(lastActive + 'T00:00:00');
    const todayDate = new Date(today + 'T00:00:00');
    const diffDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));

    console.log('Days since last active:', diffDays);

    if (diffDays === 1) {
      // Consecutive day - increase streak
      achievements.streak++;
      achievements.lastActiveDate = today;
      console.log('Consecutive day! New streak:', achievements.streak);

      // Check for streak badges (these will show celebration since celebrationsInitialized will be true after init)
      if (achievements.streak === 3) awardBadge('streak3');
      if (achievements.streak === 7) awardBadge('streak7');
      if (achievements.streak === 30) awardBadge('streak30');
    } else if (diffDays > 1) {
      // Streak broken - reset
      console.log('Streak broken! Resetting from', achievements.streak, 'to 1');
      achievements.streak = 1;
      achievements.lastActiveDate = today;
    }
  }

  saveAchievements();
  updateHeaderStreakBadge();
}

// Update header streak badge
function updateHeaderStreakBadge() {
  const badge = document.getElementById('headerStreakBadge');
  if (badge) {
    badge.textContent = achievements.streak;
    badge.dataset.streak = achievements.streak;
    badge.style.display = achievements.streak > 0 ? 'flex' : 'none';
  }
}

// Award a badge
function awardBadge(badgeId, silent = false) {
  if (achievements.badges.includes(badgeId)) return; // Already have it

  achievements.badges.push(badgeId);
  saveAchievements();

  console.log('Badge awarded:', badgeId, 'Silent:', silent);

  // Show celebration only if not silent and celebrations are initialized
  const badge = BADGES[badgeId];
  if (badge && !silent && celebrationsInitialized) {
    showAchievementPopup(badge.icon, badge.name);
    launchConfetti();
  }
}

// Show achievement popup
function showAchievementPopup(icon, name) {
  const popup = document.getElementById('achievementPopup');
  const iconEl = document.getElementById('achievementIcon');
  const nameEl = document.getElementById('achievementName');

  iconEl.textContent = icon;
  nameEl.textContent = name;

  popup.classList.remove('hidden');

  // Trigger animation
  setTimeout(() => popup.classList.add('show'), 10);

  // Hide after 4 seconds
  setTimeout(() => {
    popup.classList.remove('show');
    setTimeout(() => popup.classList.add('hidden'), 400);
  }, 4000);
}

// Show achievements modal
function showAchievementsModal() {
  const modal = document.getElementById('achievementsModal');

  // Update streak display
  document.getElementById('streakCount').textContent = achievements.streak;

  // Update streak message
  const streakMsg = document.getElementById('streakMessage');
  if (achievements.streak === 0) {
    streakMsg.textContent = 'Start using the app daily to build your streak!';
  } else if (achievements.streak < 3) {
    streakMsg.textContent = `Keep going! ${3 - achievements.streak} more days for your first streak badge!`;
  } else if (achievements.streak < 7) {
    streakMsg.textContent = `Great job! ${7 - achievements.streak} more days to become a Week Warrior!`;
  } else if (achievements.streak < 30) {
    streakMsg.textContent = `Amazing! ${30 - achievements.streak} more days to become a Monthly Master!`;
  } else {
    streakMsg.textContent = 'Incredible dedication! You are a true master!';
  }

  // Render badges
  const badgesGrid = document.getElementById('badgesGrid');
  badgesGrid.innerHTML = Object.entries(BADGES).map(([id, badge]) => {
    const earned = achievements.badges.includes(id);
    return `
      <div class="badge-item ${earned ? 'earned' : 'locked'}" title="${badge.description}">
        <span class="badge-icon">${badge.icon}</span>
        <span class="badge-name">${badge.name}</span>
      </div>
    `;
  }).join('');

  // Render stats
  const statsGrid = document.getElementById('allTimeStats');
  const uniqueStudents = [...new Set(classes.map(c => c.student))].length;
  const completedClasses = classes.filter(c => !c.cancelled && !c.pendingConfirmation && isClassCompleted(c)).length;

  statsGrid.innerHTML = `
    <div class="stat-item">
      <span class="stat-value">${completedClasses}</span>
      <span class="stat-label">Classes Completed</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${uniqueStudents}</span>
      <span class="stat-label">Students</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${achievements.badges.length}</span>
      <span class="stat-label">Badges Earned</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${achievements.streak}</span>
      <span class="stat-label">Day Streak</span>
    </div>
  `;

  console.log('Opening achievements modal');
  modal.classList.remove('hidden');
  console.log('Modal hidden class removed. Classes now:', modal.className);
}

// Close achievements modal
function closeAchievementsModal() {
  const modal = document.getElementById('achievementsModal');
  console.log('Closing achievements modal. Current classes:', modal.className);
  modal.classList.add('hidden');
  console.log('Modal hidden class added. Classes now:', modal.className);
}

// Save achievements
function saveAchievements() {
  localStorage.setItem('achievements', JSON.stringify(achievements));
}

// Check all badges based on current state
function checkAllBadges(silent = false) {
  const uniqueStudents = [...new Set(classes.map(c => c.student))];
  const completedClasses = classes.filter(c => !c.cancelled && !c.pendingConfirmation && isClassCompleted(c));

  // First class
  if (classes.length > 0) awardBadge('firstClass', silent);

  // Class milestones
  if (completedClasses.length >= 10) awardBadge('tenClasses', silent);
  if (completedClasses.length >= 50) awardBadge('fiftyClasses', silent);
  if (completedClasses.length >= 100) awardBadge('hundredClasses', silent);

  // Student milestones
  if (uniqueStudents.length >= 1) awardBadge('firstStudent', silent);
  if (uniqueStudents.length >= 5) awardBadge('fiveStudents', silent);

  // Check for early bird / night owl
  classes.forEach(c => {
    const startHour = parseInt(c.start.split(':')[0]);
    if (startHour < 8) awardBadge('earlyBird', silent);
    if (startHour >= 20) awardBadge('nightOwl', silent);
  });

  // Check payment badges
  const paidCount = Object.values(paymentStatus).filter(v => v === true).length;
  if (paidCount >= 1) awardBadge('firstPayment', silent);
  if (paidCount >= 10) awardBadge('tenPayments', silent);
}

// Celebration for payment received
function celebratePayment() {
  launchConfetti();
  showToast('🎉 Payment received!');
  checkAllBadges();
}

// Celebration for class completion (can be called when class time passes)
function celebrateClassCompletion(studentName) {
  showToast(`✨ Class with ${studentName} completed!`);
  checkAllBadges();
}
