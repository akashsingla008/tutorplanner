// State
let classes = JSON.parse(localStorage.getItem("classes")) || [];
let editingIndex = null;
let currentWeekOffset = 0;
let selectedDuration = 60; // Default 1 hour
let draggedClassIndex = null;
let isCopyDrag = false;
let reportPeriod = 'week';
let customStartDate = null;
let customEndDate = null;
let defaultRate = parseInt(localStorage.getItem('defaultRate')) || 500;
let studentRates = JSON.parse(localStorage.getItem('studentRates')) || {};
let paymentStatus = JSON.parse(localStorage.getItem('paymentStatus')) || {};
let isSelectMode = false;
let selectedClasses = new Set();

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
  renderWeekGrid();
  setupEventListeners();
  updateStudentDropdowns();
  checkForClashes();
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

      const customDateRange = document.getElementById("customDateRange");
      if (reportPeriod === "custom") {
        customDateRange.classList.remove("hidden");
      } else {
        customDateRange.classList.add("hidden");
        renderReport();
      }
    });
  });

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
    defaultRate = parseInt(e.target.value) || 0;
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
  if (currentWeekOffset === 0) {
    label.textContent = "This Week";
  } else if (currentWeekOffset === 1) {
    label.textContent = "Next Week";
  } else if (currentWeekOffset === -1) {
    label.textContent = "Last Week";
  } else {
    const startDate = getWeekStartDate(currentWeekOffset);
    label.textContent = formatDateShort(startDate);
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
  const newClasses = classes.map(c => ({ ...c }));
  let addedCount = 0;
  let skippedCount = 0;

  newClasses.forEach(cls => {
    // Check if this exact class already exists
    const exists = classes.some(c =>
      c.student === cls.student &&
      c.day === cls.day &&
      c.start === cls.start &&
      c.end === cls.end
    );

    if (!exists && !hasClash(cls)) {
      classes.push(cls);
      addedCount++;
    } else {
      skippedCount++;
    }
  });

  saveClasses();
  renderWeekGrid();

  alert(`Copied ${addedCount} classes. ${skippedCount > 0 ? `Skipped ${skippedCount} due to duplicates or clashes.` : ''}`);
}

function copyMondayToWeekdays() {
  const mondayClasses = classes.filter(c => c.day === "Monday");

  if (mondayClasses.length === 0) {
    alert("No Monday classes to copy.");
    return;
  }

  const targetDays = ["Tuesday", "Wednesday", "Thursday", "Friday"];
  let addedCount = 0;
  let skippedCount = 0;

  mondayClasses.forEach(mondayClass => {
    targetDays.forEach(day => {
      const newClass = { ...mondayClass, day };

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
  const cls = classes[classIndex];
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
  const newClass = { ...cls, day: targetDay };

  // Remove cancel status when copying
  delete newClass.cancelled;
  delete newClass.cancelReason;
  delete newClass.cancelledAt;
  delete newClass.customCancelReason;

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

    const dayColumn = document.createElement("div");
    dayColumn.className = "day-column";
    dayColumn.dataset.day = day;

    const dayClasses = classes.filter(c => c.day === day);
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
                const cancelLabel = isCancelled ? CANCEL_REASONS[c.cancelReason] || 'Cancelled' : '';
                const isSelected = selectedClasses.has(globalIndex);
                return `
                  <div class="class-card ${hasClash ? 'clash' : ''} ${isCancelled ? 'cancelled' : ''} ${isSelected ? 'selected' : ''}"
                       data-index="${globalIndex}"
                       draggable="${!isCancelled && !isSelectMode}">
                    ${isSelectMode ? `
                      <label class="select-checkbox">
                        <input type="checkbox" class="class-select-cb" data-index="${globalIndex}" ${isSelected ? 'checked' : ''} />
                      </label>
                    ` : ''}
                    <div class="class-card-content">
                      <div class="student-name">${escapeHtml(c.student)}</div>
                      <div class="class-time">${formatTime(c.start)} - ${formatTime(c.end)}</div>
                      ${isCancelled ? `<div class="cancel-badge">${cancelLabel}</div>` : ''}
                    </div>
                    ${!isCancelled && !isSelectMode ? `<button class="copy-class-btn" data-index="${globalIndex}" title="Copy to another day">⧉</button>` : ''}
                  </div>
                `;
              }).join("")
        }
      </div>
    `;

    // Add click listeners to class cards
    dayColumn.querySelectorAll(".class-card").forEach(card => {
      card.addEventListener("click", (e) => {
        // Handle select mode
        if (isSelectMode) {
          if (!e.target.classList.contains("class-select-cb")) {
            const index = parseInt(card.dataset.index);
            toggleClassSelection(index);
          }
          return;
        }
        // Don't open modal if clicking copy button or if we just finished dragging
        if (e.target.classList.contains("copy-class-btn") || card.classList.contains("dragging")) {
          return;
        }
        openEditModal(parseInt(card.dataset.index));
      });

      // Drag events (only in non-select mode)
      if (!isSelectMode) {
        card.addEventListener("dragstart", handleDragStart);
        card.addEventListener("dragend", handleDragEnd);
      }
    });

    // Add click listeners to selection checkboxes
    dayColumn.querySelectorAll(".class-select-cb").forEach(cb => {
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const index = parseInt(cb.dataset.index);
        toggleClassSelection(index);
      });
    });

    // Add click listeners to copy buttons
    dayColumn.querySelectorAll(".copy-class-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        showCopyClassDialog(parseInt(btn.dataset.index));
      });
    });

    // Drop zone events
    dayColumn.addEventListener("dragover", handleDragOver);
    dayColumn.addEventListener("dragleave", handleDragLeave);
    dayColumn.addEventListener("drop", handleDrop);

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
  draggedClassIndex = parseInt(e.target.dataset.index);
  e.target.classList.add("dragging");

  if (isCopyDrag) {
    e.target.classList.add("drag-copy");
  }

  // Set drag data
  e.dataTransfer.effectAllowed = isCopyDrag ? "copy" : "move";
  e.dataTransfer.setData("text/plain", draggedClassIndex);
}

function handleDragEnd(e) {
  e.target.classList.remove("dragging", "drag-copy");
  draggedClassIndex = null;

  // Remove all drag-over states
  document.querySelectorAll(".day-column").forEach(col => {
    col.classList.remove("drag-over", "drag-over-clash");
  });
}

function handleDragOver(e) {
  e.preventDefault();
  const dayColumn = e.currentTarget;
  const targetDay = dayColumn.dataset.day;

  if (draggedClassIndex === null) return;

  const draggedClass = classes[draggedClassIndex];
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
  e.currentTarget.classList.remove("drag-over", "drag-over-clash");
}

function handleDrop(e) {
  e.preventDefault();
  const dayColumn = e.currentTarget;
  const targetDay = dayColumn.dataset.day;

  dayColumn.classList.remove("drag-over", "drag-over-clash");

  if (draggedClassIndex === null) return;

  const draggedClass = classes[draggedClassIndex];
  const newClass = { ...draggedClass, day: targetDay };

  // Check for clash
  const excludeIndex = isCopyDrag ? null : draggedClassIndex;
  if (hasClash(newClass, excludeIndex)) {
    showToast("Cannot drop here - time clash detected!");
    return;
  }

  if (isCopyDrag) {
    // Copy the class
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
    const dayClasses = classes.filter(c => c.day === day);
    if (findClashingClasses(dayClasses).length > 0) {
      hasClashFlag = true;
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

  modal.classList.remove("hidden");
  existingStudentSelect.focus();
}

function openEditModal(index) {
  editingIndex = index;
  const cls = classes[index];

  modalTitle.textContent = "Edit Class";
  deleteBtn.classList.remove("hidden");
  duplicateBtn.classList.remove("hidden");

  // Show cancel or restore section based on class state
  if (cls.cancelled) {
    cancelSection.classList.add("hidden");
    restoreSection.classList.remove("hidden");
    cancelReasonSpan.textContent = CANCEL_REASONS[cls.cancelReason] || 'Unknown';
    copyToDaySection.classList.add("hidden");
  } else {
    cancelSection.classList.remove("hidden");
    restoreSection.classList.add("hidden");
    copyToDaySection.classList.remove("hidden");
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

  let addedCount = 0;
  let skippedCount = 0;

  selectedDays.forEach(day => {
    const newClass = {
      student: studentName,
      day,
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

  const cls = {
    student: studentName,
    day: daySelect.value,
    start: startTimeInput.value,
    end: endTimeInput.value
  };

  // Validate end time is after start time
  if (cls.end <= cls.start) {
    alert("End time must be after start time");
    return;
  }

  // Check for clashes (excluding current class if editing)
  if (hasClash(cls, editingIndex)) {
    formClashWarning.classList.remove("hidden");
    showSuggestedSlots(cls.day);
    return;
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
    return c.day === newClass.day && timesOverlap(newClass, c);
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

  const testClass = { day, start, end };

  if (hasClash(testClass, editingIndex)) {
    formClashWarning.classList.remove("hidden");
    showSuggestedSlots(day);
  } else {
    formClashWarning.classList.add("hidden");
    suggestedSlots.classList.add("hidden");
  }
}

// Auto-Suggest Available Slots
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

  // Add click listeners to slot chips
  slotsList.querySelectorAll(".slot-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      startTimeInput.value = chip.dataset.start;
      endTimeInput.value = chip.dataset.end;
      checkFormClash();
      updateQuickSlotsClashState();
      updateCopyToDayClashState();
    });
  });

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
function getReportDateRange() {
  const now = new Date();
  let startDate, endDate, label;

  if (reportPeriod === 'week') {
    // Get current week (Monday to Sunday)
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    startDate = new Date(now);
    startDate.setDate(now.getDate() + diff);
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);

    label = `Week of ${formatDateLong(startDate)}`;
  } else if (reportPeriod === 'month') {
    // Get current month
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    label = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } else if (reportPeriod === 'custom' && customStartDate && customEndDate) {
    startDate = new Date(customStartDate);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(customEndDate);
    endDate.setHours(23, 59, 59, 999);

    label = `${formatDateLong(startDate)} - ${formatDateLong(endDate)}`;
  } else {
    // Default to this week
    return getReportDateRange();
  }

  return { startDate, endDate, label };
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getClassesInRange(startDate, endDate) {
  // Since we don't store actual dates, we need to match by day name
  // For a proper implementation, you'd want to store actual dates with classes
  // For now, we'll return all classes (simulating current week/month)
  return classes;
}

function renderReport() {
  const { startDate, endDate, label } = getReportDateRange();

  // Update period label
  document.getElementById("reportPeriodLabel").textContent = label;

  // Create a period key for payment tracking
  const periodKey = `${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}`;

  // Get classes in range (for now, all classes since we don't have date-specific data)
  const classesInRange = getClassesInRange(startDate, endDate);

  // Calculate totals
  let totalClasses = classesInRange.length;
  let cancelledCount = classesInRange.filter(c => c.cancelled).length;
  let completedCount = totalClasses - cancelledCount;
  let totalMinutes = 0;

  // Calculate hours for non-cancelled classes
  classesInRange.forEach(c => {
    if (!c.cancelled) {
      totalMinutes += getMinutesBetween(c.start, c.end);
    }
  });

  const totalHours = (totalMinutes / 60).toFixed(1);

  // Update summary cards
  document.getElementById("totalClasses").textContent = totalClasses;
  document.getElementById("completedClasses").textContent = completedCount;
  document.getElementById("cancelledClasses").textContent = cancelledCount;
  document.getElementById("totalHours").textContent = totalHours;

  // Calculate per-student stats
  const studentStats = {};
  classesInRange.forEach(c => {
    if (!studentStats[c.student]) {
      studentStats[c.student] = {
        total: 0,
        cancelled: 0,
        minutes: 0
      };
    }
    studentStats[c.student].total++;
    if (c.cancelled) {
      studentStats[c.student].cancelled++;
    } else {
      studentStats[c.student].minutes += getMinutesBetween(c.start, c.end);
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
      const hours = (stats.minutes / 60).toFixed(1);
      const rate = studentRates[student] || defaultRate;
      const amount = Math.round((stats.minutes / 60) * rate);
      totalAmount += amount;

      // Check payment status for this student and period
      const paymentKey = `${student}_${periodKey}`;
      const isPaid = paymentStatus[paymentKey] || false;
      if (isPaid) paidAmount += amount;

      return `
        <tr class="${isPaid ? 'payment-cleared' : 'payment-pending'}">
          <td><strong>${escapeHtml(student)}</strong></td>
          <td>${stats.total - stats.cancelled}</td>
          <td class="cancelled-count">${stats.cancelled > 0 ? stats.cancelled : '-'}</td>
          <td>${hours}</td>
          <td>
            <input type="number" class="student-rate-input"
                   data-student="${escapeHtml(student)}"
                   value="${rate}"
                   min="0" step="50" />
          </td>
          <td class="amount">₹${amount.toLocaleString()}</td>
          <td class="payment-cell">
            <label class="payment-checkbox">
              <input type="checkbox" class="payment-toggle"
                     data-student="${escapeHtml(student)}"
                     data-period="${periodKey}"
                     ${isPaid ? 'checked' : ''} />
              <span class="payment-label">${isPaid ? 'Paid' : 'Pending'}</span>
            </label>
            ${!isPaid && amount > 0 ? `
              <button class="reminder-btn" data-student="${escapeHtml(student)}" data-amount="${amount}" title="Send payment reminder">
                📩
              </button>
            ` : ''}
          </td>
        </tr>
      `;
    }).join('');

    // Add event listeners to rate inputs
    tbody.querySelectorAll('.student-rate-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const student = e.target.dataset.student;
        const newRate = parseInt(e.target.value) || 0;
        studentRates[student] = newRate;
        localStorage.setItem('studentRates', JSON.stringify(studentRates));
        renderReport();
      });
    });

    // Add event listeners to payment toggles
    tbody.querySelectorAll('.payment-toggle').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const student = e.target.dataset.student;
        const period = e.target.dataset.period;
        const paymentKey = `${student}_${period}`;
        paymentStatus[paymentKey] = e.target.checked;
        localStorage.setItem('paymentStatus', JSON.stringify(paymentStatus));
        renderReport();
      });
    });

    // Add event listeners to reminder buttons
    tbody.querySelectorAll('.reminder-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const student = e.target.dataset.student;
        const amount = e.target.dataset.amount;
        sendPaymentReminder(student, amount, label);
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
}

// Send payment reminder
function sendPaymentReminder(student, amount, period) {
  const message = `Hello! 🙏

Hope you and your family are doing well! I wanted to gently follow up regarding ${student}'s tuition fees for the recent classes.

📅 Period: ${period}
💰 Amount: ₹${parseInt(amount).toLocaleString()}

I completely understand that sometimes things get busy, so no rush at all! Whenever it's convenient for you, please let me know if you have any questions or if you'd like to discuss anything.

Thank you so much for your continued support and trust in Mindful Maths! It's truly a pleasure teaching ${student}. 😊

Warm regards,
Mahak
Mindful Maths`;

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
