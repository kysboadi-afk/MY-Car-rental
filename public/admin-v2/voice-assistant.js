/**
 * voice-assistant.js
 * SLYTRANS Fleet Control — AI Voice Assistant
 *
 * Features:
 *  • speak(text, lang, priority) — TTS via /api/tts (cached, cancelable, priority-gated)
 *  • Page Guide                 — speaks tour steps for whichever page is currently visible;
 *                                  no forced navigation; skips invisible elements automatically
 *  • Full System Tour           — navigates dashboard → bookings → vehicles → customers →
 *                                  revenue → analytics; ideal for demos and onboarding
 *  • Ask Assistant              — text Q&A via /api/admin-chat, response spoken aloud
 *  • Context-Aware Click-Explain — opt-in; explains any actionable element with full
 *                                  section + session context; covers every page/modal
 *  • Universal Action Feedback  — hooks showToast; speaks every success toast aloud
 *  • Session Memory             — auto-tracks current section, open modal, active booking,
 *                                 customer, and last action via MutationObserver
 *  • Language Toggle            — EN / ES; all speech respects chosen language
 *
 * Depends on globals defined in index.html:
 *   API_BASE, adminSecret, currentPage
 *
 * Mounted automatically on DOMContentLoaded.
 */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const PANEL_ID              = 'va-panel';
  const BUBBLE_ID             = 'va-bubble';
  const LANG_STORAGE          = 'va_lang';
  const MUTE_STORAGE          = 'va_mute';
  const HIDE_STORAGE          = 'va_hidden';
  const CLICK_EXPLAIN_DEBOUNCE_MS = 1500;   // minimum gap between click-explain triggers
  const MAX_HIGHLIGHT         = 4000;       // ms to keep highlight ring visible
  const MAX_MODAL_WAIT_MS     = 60000;      // max ms to wait for a modal to open during tour
  const TTS_CACHE_MAX         = 80;         // max cached TTS entries before eviction
  const VALID_LANGS           = ['en', 'es'];

  // Speech priority levels — higher number wins.
  // Guide audio is never interrupted; assistant and action feedback beat click-explain.
  const PRIORITY = { explain: 1, assistant: 2, guide: 3 };

  // Shared voice persona injected into every AI prompt to ensure a consistent tone
  // across click-explain, ask-assistant, and any future AI paths.
  const VOICE_PERSONA =
    'You are a concise, professional voice assistant for a car rental business admin dashboard. ' +
    'Always respond in plain spoken English (no markdown, no lists, no bullet points). ' +
    'Keep replies to 1-2 short sentences unless otherwise instructed.';

  // Keywords that indicate an element is actionable and worth explaining.
  // Matched case-insensitively against the button's cleaned label text.
  // Covers every action type across all admin sections.
  const EXPLAIN_KEYWORDS = [
    'extend', 'extension', 'fix', 'create', 'add', 'new',
    'view', 'open', 'mark', 'cancel', 'approve', 'decline',
    'charge', 'waive', 'save', 'delete', 'remove', 'edit',
    'upload', 'sync', 'resend', 'return', 'block', 'unblock',
    'complete', 'confirm', 'submit', 'flag', 'unflag',
    'refresh', 'resolve', 'dismiss', 'apply', 'update',
    // Additional actions across all sections
    'connect', 'disconnect', 'run', 'reset', 'clear', 'relink',
    'reconcile', 'heal', 'generate', 'send', 'enable', 'disable',
    'download', 'export', 'import', 'recompute', 'compute',
    'diagnose', 'check', 'search', 'filter', 'assign', 'transfer',
    'archive', 'restore', 'duplicate', 'merge', 'split',
  ];

  // Human-readable section labels for each dashboard page (EN and ES).
  const SECTION_LABELS = {
    dashboard:          { en: 'Dashboard',          es: 'Tablero' },
    bookings:           { en: 'Bookings',           es: 'Reservas' },
    'bookings-raw':     { en: 'Raw Bookings',       es: 'Reservas Sin Procesar' },
    vehicles:           { en: 'Vehicles',           es: 'Vehículos' },
    'vehicle-profile':  { en: 'Vehicle Profile',    es: 'Perfil del Vehículo' },
    expenses:           { en: 'Expenses',           es: 'Gastos' },
    revenue:            { en: 'Revenue',            es: 'Ingresos' },
    analytics:          { en: 'Analytics',          es: 'Analítica' },
    customers:          { en: 'Customers',          es: 'Clientes' },
    'fleet-status':     { en: 'Fleet Status',       es: 'Estado de Flota' },
    gps:                { en: 'GPS Tracking',       es: 'Rastreo GPS' },
    'block-dates':      { en: 'Block Dates',        es: 'Bloquear Fechas' },
    sms:                { en: 'SMS Templates',      es: 'Plantillas SMS' },
    'late-fees':        { en: 'Late Fees',          es: 'Cargos por Mora' },
    ai:                 { en: 'AI Assistant',       es: 'Asistente IA' },
    'system-health':    { en: 'System Health',      es: 'Salud del Sistema' },
    'system-settings':  { en: 'System Settings',   es: 'Configuración del Sistema' },
    'manual-booking':   { en: 'Manual Booking',     es: 'Reserva Manual' },
    'protection-plans': { en: 'Protection Plans',  es: 'Planes de Protección' },
    'vehicle-pricing':  { en: 'Vehicle Pricing',   es: 'Precios de Vehículos' },
    settings:           { en: 'Site Settings',      es: 'Configuración del Sitio' },
  };

  // Modal section overrides: when a modal is open, use this section name instead
  // of the underlying page.  Covers every modal in the admin dashboard.
  const MODAL_SECTION = {
    'booking-detail-modal':   { en: 'Booking Detail modal',     es: 'modal de Detalle de Reserva' },
    'booking-edit-modal':     { en: 'Booking Edit modal',       es: 'modal de Edición de Reserva' },
    'edit-vehicle-modal':     { en: 'Vehicle Edit modal',       es: 'modal de Edición de Vehículo' },
    'add-vehicle-modal':      { en: 'Add Vehicle modal',        es: 'modal de Agregar Vehículo' },
    'add-expense-modal':      { en: 'Add Expense modal',        es: 'modal de Agregar Gasto' },
    'lf-charge-modal':        { en: 'Charge Late Fee modal',    es: 'modal de Cobrar Cargo por Mora' },
    'lf-waive-modal':         { en: 'Waive Late Fee modal',     es: 'modal de Eximir Cargo por Mora' },
    'lf-edit-modal':          { en: 'Edit Late Fee modal',      es: 'modal de Editar Cargo por Mora' },
    'resend-extension-modal': { en: 'Extend Rental modal',      es: 'modal de Extender Alquiler' },
    'customer-edit-modal':    { en: 'Customer Edit modal',      es: 'modal de Edición de Cliente' },
    'customer-detail-modal':  { en: 'Customer Detail modal',    es: 'modal de Detalle de Cliente' },
    'plan-modal':             { en: 'Protection Plan modal',    es: 'modal de Plan de Protección' },
    'sms-edit-modal':         { en: 'SMS Template modal',       es: 'modal de Plantilla SMS' },
    'revenue-modal':          { en: 'Revenue Record modal',     es: 'modal de Registro de Ingresos' },
  };

  // Per-page tour scripts (EN / ES).
  // Each key maps to the page name used in navigate() / currentPage.
  // Steps are spoken only for the page that is currently visible,
  // so the guide always matches the UI in real time.
  const PAGE_TOUR_STEPS = {
    dashboard: [
      {
        sel: '#page-dashboard',
        en:  'Welcome to the Dashboard — your command center. ' +
             'At the top you will see live KPI tiles showing total revenue, active rentals, bookings this month, and more.',
        es:  'Bienvenido al Tablero, su centro de mando. ' +
             'En la parte superior verá los indicadores clave: ingresos totales, rentas activas, reservas del mes y más.',
      },
      {
        sel: '#kpi-grid',
        en:  'These KPI cards update in real time. Click any card to drill into the related section.',
        es:  'Estas tarjetas de KPI se actualizan en tiempo real. Haga clic en cualquiera para ir a la sección relacionada.',
      },
      {
        sel: '#action-required-card',
        en:  'The Action Required panel shows items that need immediate attention: pending approvals, pickups today, returns today, and overdue rentals. ' +
             'Tap any tile to jump straight to those bookings. The Refresh button reloads the counts.',
        es:  'El panel de Acción Requerida muestra los elementos que necesitan atención inmediata: aprobaciones pendientes, recogidas hoy, devoluciones hoy y rentas vencidas. ' +
             'Toque cualquier mosaico para ir directamente a esas reservas. El botón Actualizar recarga los conteos.',
      },
      {
        sel: '.charts-grid',
        en:  'Below the action tiles you have two charts: Revenue Over Time shows your monthly income trend, ' +
             'and Bookings by Vehicle breaks down paid bookings per car.',
        es:  'Debajo de los mosaicos de acción hay dos gráficos: Ingresos en el Tiempo muestra su tendencia de ingresos mensuales, ' +
             'y Reservas por Vehículo desglosa las reservas pagadas por auto.',
      },
      {
        sel: '.alerts-grid',
        en:  'At the bottom you have the Alerts and Actions feed — live notifications requiring your input — ' +
             'and the Recent Bookings list showing your latest reservations at a glance.',
        es:  'En la parte inferior está el panel de Alertas y Acciones con notificaciones que requieren su intervención, ' +
             'y la lista de Reservas Recientes con sus últimas reservaciones.',
      },
      {
        sel: null,
        en:  'That is the full Dashboard overview.',
        es:  'Eso es el resumen completo del Tablero.',
      },
    ],
    vehicles: [
      {
        sel: '#page-vehicles',
        en:  'The Vehicles page lists every car in your fleet. ' +
             'Each card shows the vehicle name, status, and quick-action buttons.',
        es:  'La página de Vehículos lista todos los autos de su flota. ' +
             'Cada tarjeta muestra el nombre del vehículo, estado y botones de acción rápida.',
      },
      {
        sel: '#vehicles-content',
        en:  'For each vehicle you have three actions: ' +
             'Edit opens a form to update the vehicle name, year, license plate, and notes. ' +
             'Upload Photo lets you replace the car image shown on the public website. ' +
             'View Profile takes you to the full vehicle history and performance stats.',
        es:  'Para cada vehículo tiene tres acciones: ' +
             'Editar abre un formulario para actualizar el nombre, año, matrícula y notas. ' +
             'Subir Foto permite reemplazar la imagen del auto en el sitio público. ' +
             'Ver Perfil lo lleva al historial completo y estadísticas de rendimiento.',
      },
      {
        sel: null,
        en:  'That is the Vehicles section.',
        es:  'Esa es la sección de Vehículos.',
      },
    ],
    'vehicle-profile': [
      {
        sel: '#page-vehicle-profile',
        en:  'The Vehicle Profile page shows the complete performance and maintenance record for one specific vehicle. ' +
             'The Back to Vehicles button at the top returns you to the fleet list. ' +
             'The Edit Vehicle button opens the edit form where you can update the name, type, status, year, purchase price, and Bouncie device ID.',
        es:  'La página de Perfil del Vehículo muestra el rendimiento completo y el registro de mantenimiento de un vehículo específico. ' +
             'El botón Regresar a Vehículos en la parte superior lo lleva de vuelta a la lista de flota. ' +
             'El botón Editar Vehículo abre el formulario para actualizar el nombre, tipo, estado, año, precio de compra e ID del dispositivo Bouncie.',
      },
      {
        sel: '#vehicle-profile-content',
        en:  'The financial KPI cards show the vehicle\'s purchase price, total bookings completed, lifetime gross revenue, total expenses logged, net profit, and return on investment percentage — ' +
             'giving you a clear picture of whether this vehicle is profitable.',
        es:  'Las tarjetas de KPI financiero muestran el precio de compra del vehículo, reservas totales completadas, ingresos brutos de por vida, gastos totales registrados, ganancia neta y porcentaje de retorno de inversión, ' +
             'dándole una imagen clara de si este vehículo es rentable.',
      },
      {
        sel: '#vehicle-profile-content',
        en:  'The GPS Tracking section shows the vehicle\'s linked Bouncie device ID, current odometer reading, and the last time GPS data was synced. ' +
             'The Sync Now button forces an immediate GPS data pull from Bouncie for this vehicle.',
        es:  'La sección de Rastreo GPS muestra el ID del dispositivo Bouncie vinculado, la lectura actual del odómetro y la última vez que se sincronizaron los datos GPS. ' +
             'El botón Sincronizar Ahora fuerza una actualización inmediata de los datos GPS de Bouncie para este vehículo.',
      },
      {
        sel: '#vehicle-profile-content',
        en:  'The Maintenance Records table tracks three service types: Oil Change, Brake Inspection, and Tire Replacement. ' +
             'Each row shows the last recorded mileage and miles driven since. ' +
             'A yellow warning appears when a service is eighty percent due, and a red alert when it is overdue. ' +
             'The Oil Done button records the current odometer as the last oil change. ' +
             'Brakes Done records the last brake check. ' +
             'Tires Done records the last tire replacement.',
        es:  'La tabla de Registros de Mantenimiento rastrea tres tipos de servicio: Cambio de Aceite, Inspección de Frenos y Reemplazo de Llantas. ' +
             'Cada fila muestra el último kilometraje registrado y los kilómetros recorridos desde entonces. ' +
             'Aparece una advertencia amarilla cuando un servicio está al ochenta por ciento de su intervalo, y una alerta roja cuando está vencido. ' +
             'El botón Aceite Listo registra el odómetro actual como el último cambio de aceite. ' +
             'Frenos Listos registra la última revisión de frenos. ' +
             'Llantas Listas registra el último reemplazo de llantas.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Profile section.',
        es:  'Esa es la sección de Perfil del Vehículo.',
      },
    ],
    bookings: [
      {
        sel: '#page-bookings',
        en:  'The Bookings section is the main hub for all reservations. ' +
             'At the top you have filter dropdowns: filter by vehicle, status, payment type, risk level, or profitability. ' +
             'Use the search box to find a booking by customer name or booking ID.',
        es:  'La sección de Reservas es el centro principal de todas las reservaciones. ' +
             'En la parte superior hay filtros: por vehículo, estado, tipo de pago, nivel de riesgo o rentabilidad. ' +
             'Use la búsqueda para encontrar una reserva por nombre o ID.',
      },
      {
        sel: '#bookings-table-wrap',
        en:  'The table shows each booking with the customer name, vehicle, dates, financials, payment method, customer tier, and current status. ' +
             'The View button on each row opens the full Booking Detail panel.',
        es:  'La tabla muestra cada reserva con nombre del cliente, vehículo, fechas, finanzas, método de pago, nivel del cliente y estado actual. ' +
             'El botón Ver en cada fila abre el panel completo de Detalle de Reserva.',
      },
      {
        sel:          '#bookings-table-wrap',
        waitForModal: '#booking-detail-modal',
        en:  'Please click the View button on any booking row to open the Booking Detail panel — the guide will continue once it opens.',
        es:  'Haga clic en el botón Ver de cualquier fila para abrir el panel de Detalle de Reserva. El recorrido continuará cuando se abra.',
        // fullTourText: used by the Full System Tour instead of the interactive
        // waitForModal prompt, so the tour can cover this content hands-free.
        fullTourEn:
          'Each booking row has a View button that opens the full Booking Detail panel. ' +
          'Inside you can see complete customer info, vehicle assignment, rental dates, payment breakdown, and status history. ' +
          'Action buttons let you Approve, Mark as Active, Mark Returned, Extend, or Cancel the booking. ' +
          'Additional actions include Flag Issue, Resend Email, Edit Booking, and Delete Booking.',
        fullTourEs:
          'Cada fila tiene un botón Ver que abre el panel completo de Detalle de Reserva. ' +
          'Dentro puede ver información del cliente, vehículo, fechas, desglose de pagos e historial. ' +
          'Los botones de acción permiten Aprobar, Marcar como Activa, Marcar como Devuelta, Extender o Cancelar la reserva. ' +
          'Acciones adicionales incluyen Marcar Problema, Reenviar Correo, Editar y Eliminar Reserva.',
      },
      {
        sel:          '#booking-detail-modal',
        skipIfHidden: true,
        en:  'Inside the Booking Detail panel you can see the full customer info, vehicle assignment, rental dates, payment breakdown, and status history.',
        es:  'Dentro del panel de Detalle de Reserva puede ver la información completa del cliente, vehículo, fechas de renta, desglose de pagos e historial de estados.',
      },
      {
        sel:          '#booking-detail-actions',
        skipIfHidden: true,
        en:  'The primary action buttons depend on the booking status. ' +
             'For a pending booking: Approve Booking confirms it as paid. ' +
             'Mark as Active is pressed when the customer picks up the car and the rental begins. ' +
             'Mark Returned ends the rental and logs the return time. ' +
             'Extend Rental opens a form to add more days to an active booking. ' +
             'Cancel Booking voids the reservation.',
        es:  'Los botones de acción principales dependen del estado de la reserva. ' +
             'Para una reserva pendiente: Aprobar Reserva la confirma como pagada. ' +
             'Marcar como Activa se presiona cuando el cliente recoge el auto y comienza la renta. ' +
             'Marcar como Devuelta termina la renta y registra la hora de devolución. ' +
             'Extender Alquiler abre un formulario para agregar más días a una renta activa. ' +
             'Cancelar Reserva anula la reservación.',
      },
      {
        sel:          '#booking-detail-actions',
        skipIfHidden: true,
        en:  'Additional actions are always available regardless of status: ' +
             'Flag Issue marks the booking for attention — for example if there is a dispute or suspicious activity. ' +
             'Resend Email sends the customer a fresh confirmation email with their booking details. ' +
             'Edit Booking opens a form to change the dates, amounts, or notes. ' +
             'Delete Booking permanently removes the record — use only when absolutely necessary.',
        es:  'Acciones adicionales siempre disponibles sin importar el estado: ' +
             'Marcar Problema señala la reserva para atención, por ejemplo en caso de disputa o actividad sospechosa. ' +
             'Reenviar Correo envía al cliente un nuevo correo de confirmación con los detalles de su reserva. ' +
             'Editar Reserva abre un formulario para cambiar fechas, montos o notas. ' +
             'Eliminar Reserva elimina permanentemente el registro — úselo solo cuando sea absolutamente necesario.',
      },
      {
        sel: null,
        en:  'That covers the Bookings section.',
        es:  'Eso cubre la sección de Reservas.',
      },
    ],
    'bookings-raw': [
      {
        sel: '#page-bookings-raw',
        en:  'Raw Bookings shows every booking record exactly as it is stored in the database — ' +
             'no filters, no grouping. This is useful for auditing payment data or debugging webhook issues.',
        es:  'Reservas Sin Procesar muestra cada registro exactamente como está almacenado en la base de datos, ' +
             'sin filtros ni agrupaciones. Es útil para auditar pagos o depurar problemas con webhooks.',
      },
      {
        sel: '#page-bookings-raw',
        en:  'The table shows every booking with its reference ID, customer name, vehicle, pickup date, return date, amount paid, status, and data source — ' +
             'whether it came from Supabase or a local JSON fallback. ' +
             'The Refresh button reloads all records directly from the database.',
        es:  'La tabla muestra cada reserva con su ID de referencia, nombre del cliente, vehículo, fecha de recogida, devolución, monto pagado, estado y fuente de datos, ' +
             'ya sea Supabase o un respaldo JSON local. ' +
             'El botón Actualizar recarga todos los registros directamente de la base de datos.',
      },
      {
        sel: null,
        en:  'That is the Raw Bookings section.',
        es:  'Esa es la sección de Reservas Sin Procesar.',
      },
    ],
    'manual-booking': [
      {
        sel: '#page-manual-booking',
        en:  'Manual Booking lets you create a reservation directly without an online payment — ' +
             'perfect for cash, Zelle, or phone-in reservations.',
        es:  'Reserva Manual le permite crear una reservación directamente sin pago en línea, ' +
             'ideal para pagos en efectivo, Zelle o reservas por teléfono.',
      },
      {
        sel: '#manual-booking-form',
        en:  'Fill in the Customer Information section with the renter\'s name, phone, and email. ' +
             'Then select the vehicle, payment method — cash, Zelle, Stripe, or other — and set the pickup and return dates and times.',
        es:  'Complete la sección de Información del Cliente con nombre, teléfono y correo del arrendatario. ' +
             'Luego seleccione el vehículo, método de pago — efectivo, Zelle, Stripe u otro — y establezca las fechas y horas de recogida y devolución.',
      },
      {
        sel: '#manual-booking-form',
        en:  'The Pricing section shows the auto-calculated amount based on the vehicle and dates. ' +
             'You can override that amount in the Amount Paid field if needed. ' +
             'Add any notes — like a cash receipt number or agreement reference — in the Notes box.',
        es:  'La sección de Precios muestra el monto calculado automáticamente según el vehículo y las fechas. ' +
             'Puede sobrescribir ese monto en el campo de Monto Pagado si es necesario. ' +
             'Agregue notas como número de recibo o referencia en el campo de Notas.',
      },
      {
        sel: '#manual-booking-form',
        en:  'The Clear Form button resets all fields if you need to start over. ' +
             'The Save Booking button creates the reservation and adds it to the Bookings table immediately.',
        es:  'El botón Limpiar Formulario restablece todos los campos si necesita empezar de nuevo. ' +
             'El botón Guardar Reserva crea la reservación y la agrega inmediatamente a la tabla de Reservas.',
      },
      {
        sel: null,
        en:  'That is the Manual Booking section.',
        es:  'Esa es la sección de Reserva Manual.',
      },
    ],
    'fleet-status': [
      {
        sel: '#page-fleet-status',
        en:  'Fleet Status shows the availability toggle for each vehicle. ' +
             'When a vehicle is toggled ON, it appears on the public website and customers can book it online. ' +
             'Toggle it OFF to hide it from bookings — useful during maintenance or when a car is out of service.',
        es:  'Estado de Flota muestra el interruptor de disponibilidad de cada vehículo. ' +
             'Cuando está activado, el vehículo aparece en el sitio público y los clientes pueden reservarlo. ' +
             'Desactívelo para ocultarlo — útil durante mantenimiento o cuando el auto está fuera de servicio.',
      },
      {
        sel: '#page-fleet-status',
        en:  'The Refresh button reloads the current availability data from the database.',
        es:  'El botón Actualizar recarga los datos actuales de disponibilidad desde la base de datos.',
      },
      {
        sel: null,
        en:  'That is the Fleet Status section.',
        es:  'Esa es la sección de Estado de Flota.',
      },
    ],
    gps: [
      {
        sel: '#page-gps',
        en:  'GPS Tracking shows the live location of each vehicle via Bouncie integration. ' +
             'You will see a card for each car showing its last known address, odometer reading, and when it was last updated.',
        es:  'Rastreo GPS muestra la ubicación en vivo de cada vehículo mediante la integración con Bouncie. ' +
             'Verá una tarjeta por auto con su última dirección conocida, lectura del odómetro y la última actualización.',
      },
      {
        sel: '#page-gps',
        en:  'The Sync Now button pulls the latest GPS data from Bouncie immediately. ' +
             'The Refresh button reloads the page data. ' +
             'The Auto-Refresh toggle keeps the map and cards updating automatically every minute.',
        es:  'El botón Sincronizar Ahora obtiene los datos GPS más recientes de Bouncie de inmediato. ' +
             'El botón Actualizar recarga los datos de la página. ' +
             'El interruptor Auto-Actualizar mantiene el mapa y las tarjetas actualizados automáticamente cada minuto.',
      },
      {
        sel: '#page-gps',
        en:  'If Bouncie is not yet connected, you will see a Connect Bouncie Now button. ' +
             'Click it to link your Bouncie account, or go to System Settings to enter your credentials.',
        es:  'Si Bouncie no está conectado todavía, verá el botón Conectar Bouncie Ahora. ' +
             'Haga clic para vincular su cuenta de Bouncie, o vaya a Configuración del Sistema para ingresar sus credenciales.',
      },
      {
        sel: null,
        en:  'That is the GPS Tracking section.',
        es:  'Esa es la sección de Rastreo GPS.',
      },
    ],
    'block-dates': [
      {
        sel: '#page-block-dates',
        en:  'Block Dates lets you prevent bookings on specific date ranges for any vehicle — ' +
             'perfect for scheduled maintenance, inspections, or planned downtime.',
        es:  'Bloquear Fechas le permite evitar reservas en rangos de fechas específicos para cualquier vehículo, ' +
             'ideal para mantenimiento programado, inspecciones o tiempo de inactividad planificado.',
      },
      {
        sel: '#page-block-dates',
        en:  'On the left side, the Block Dates form: select a vehicle, choose a from-date and to-date, then click the Block Dates button to lock that range. ' +
             'On the right side, the Unblock Dates form: select the vehicle and the same date range and click Unblock Dates to re-open availability.',
        es:  'En el lado izquierdo, el formulario de Bloqueo: seleccione un vehículo, elija fecha de inicio y fin, luego haga clic en Bloquear Fechas para bloquear ese rango. ' +
             'En el lado derecho, el formulario de Desbloqueo: seleccione el vehículo y el mismo rango de fechas y haga clic en Desbloquear para reabrir la disponibilidad.',
      },
      {
        sel: '#page-block-dates',
        en:  'The Current Blocked Date Ranges card at the bottom lists all active blocks. ' +
             'Use the Refresh button to reload the list after making changes.',
        es:  'La tarjeta de Rangos de Fechas Bloqueadas al fondo lista todos los bloqueos activos. ' +
             'Use el botón Actualizar para recargar la lista después de hacer cambios.',
      },
      {
        sel: null,
        en:  'That is the Block Dates section.',
        es:  'Esa es la sección de Bloquear Fechas.',
      },
    ],
    expenses: [
      {
        sel: '#page-expenses',
        en:  'The Expenses page lets you record and track all costs associated with running your fleet: ' +
             'maintenance, fuel, insurance, repairs, registration fees, and more.',
        es:  'La página de Gastos le permite registrar y rastrear todos los costos asociados con la operación de su flota: ' +
             'mantenimiento, combustible, seguros, reparaciones, registros y más.',
      },
      {
        sel: '#exp-kpi-grid',
        en:  'At the top you will see KPI summary tiles showing your total expenses, broken down by vehicle and by category, ' +
             'so you can instantly see where your money is going.',
        es:  'En la parte superior verá mosaicos de resumen KPI que muestran el total de gastos, desglosados por vehículo y por categoría, ' +
             'para que pueda ver de inmediato a dónde va su dinero.',
      },
      {
        sel: '#page-expenses',
        en:  'The Add Expense button at the top opens a form where you choose the vehicle, category, amount, date, and an optional note. ' +
             'Categories include maintenance, insurance, repair, fuel, registration, and other. ' +
             'Once saved, the expense immediately affects your profit calculations in Fleet Analytics.',
        es:  'El botón Agregar Gasto en la parte superior abre un formulario para elegir el vehículo, categoría, monto, fecha y nota opcional. ' +
             'Las categorías incluyen mantenimiento, seguros, reparación, combustible, registro y otro. ' +
             'Una vez guardado, el gasto afecta inmediatamente los cálculos de ganancia en Analítica de Flota.',
      },
      {
        sel: '#page-expenses',
        en:  'Use the filter dropdowns below the add button to narrow the expense list by vehicle or category. ' +
             'Each expense row has an Edit button to update the details and a Delete button to permanently remove it.',
        es:  'Use los filtros debajo del botón agregar para reducir la lista de gastos por vehículo o categoría. ' +
             'Cada fila de gasto tiene un botón Editar para actualizar los detalles y un botón Eliminar para removerlo permanentemente.',
      },
      {
        sel: null,
        en:  'That is the Expenses section.',
        es:  'Esa es la sección de Gastos.',
      },
    ],
    revenue: [
      {
        sel: '#page-revenue',
        en:  'The Revenue page tracks every income record in the system. ' +
             'Each row shows the customer, vehicle, dates, gross amount, Stripe fees, refunds, net revenue, payment method, and status.',
        es:  'La página de Ingresos rastrea cada registro de ingreso en el sistema. ' +
             'Cada fila muestra el cliente, vehículo, fechas, monto bruto, comisiones de Stripe, reembolsos, ingreso neto, método de pago y estado.',
      },
      {
        sel: '#page-revenue',
        en:  'The filter row at the top has two dropdowns — filter by vehicle or by status — to narrow down the records you see.',
        es:  'La fila de filtros en la parte superior tiene dos menús desplegables: filtrar por vehículo o por estado, para reducir los registros visibles.',
      },
      {
        sel: '#btn-stripe-reconcile',
        en:  'Sync from Stripe pulls in any payments from Stripe that are not yet recorded in the system — ' +
             'use this after a payment appears in Stripe but is missing here.',
        es:  'Sincronizar desde Stripe importa los pagos de Stripe que aún no están registrados en el sistema. ' +
             'Úselo cuando un pago aparezca en Stripe pero falte aquí.',
      },
      {
        sel: '#btn-dedup',
        en:  'Fix Duplicates removes any duplicate revenue records that may have been created during a Stripe sync. ' +
             'Run this if you notice the same booking appearing twice in the revenue list.',
        es:  'Corregir Duplicados elimina los registros de ingreso duplicados creados durante una sincronización de Stripe. ' +
             'Úselo si nota que la misma reserva aparece dos veces en la lista de ingresos.',
      },
      {
        sel: '#btn-cleanup-orphans',
        en:  'Fix Unknown resolves revenue records that have a missing or unrecognized vehicle — ' +
             'it tries to match them to bookings and corrects the vehicle assignment automatically.',
        es:  'Corregir Desconocidos resuelve los registros de ingresos con vehículo faltante o no reconocido, ' +
             'intentando emparejarlos con reservas y corrigiendo la asignación de vehículo automáticamente.',
      },
      {
        sel: '#btn-revenue-heal',
        en:  'Relink Orphans reconnects revenue records that lost their link to a booking, ' +
             'fixing undercounts you might see in Fleet Analytics or the Revenue Tracker.',
        es:  'Revincular Huérfanos reconecta los registros de ingresos que perdieron su vínculo con una reserva, ' +
             'corrigiendo los conteos bajos que puede ver en Analítica de Flota o en el Rastreador de Ingresos.',
      },
      {
        sel: '#page-revenue',
        en:  'The Add Record button lets you manually create an income entry — useful for recording cash payments or off-system transactions.',
        es:  'El botón Agregar Registro permite crear manualmente una entrada de ingreso, útil para registrar pagos en efectivo o transacciones fuera del sistema.',
      },
      {
        sel: null,
        en:  'That is the Revenue section.',
        es:  'Esa es la sección de Ingresos.',
      },
    ],
    analytics: [
      {
        sel: '#page-analytics',
        en:  'Fleet Analytics gives you a complete financial performance overview of your entire operation.',
        es:  'Analítica de Flota le brinda una visión completa del rendimiento financiero de toda su operación.',
      },
      {
        sel: '#analytics-kpi-grid',
        en:  'The KPI cards at the top summarize total bookings, gross revenue, net revenue after fees, total expenses, and overall profit.',
        es:  'Las tarjetas KPI en la parte superior resumen el total de reservas, ingresos brutos, ingresos netos después de comisiones, gastos totales y ganancia general.',
      },
      {
        sel: '.charts-grid',
        en:  'The Revenue Trend chart shows your monthly income over the last twelve months. ' +
             'The Fleet Utilization chart shows the percentage of available days each vehicle was rented.',
        es:  'El gráfico de Tendencia de Ingresos muestra sus ingresos mensuales de los últimos doce meses. ' +
             'El gráfico de Utilización de Flota muestra el porcentaje de días disponibles que fue rentado cada vehículo.',
      },
      {
        sel: '#analytics-tbody',
        en:  'The Vehicle Performance table breaks down every vehicle individually: bookings count, gross and net revenue, expenses, profit, return on investment, monthly profit, payback period, utilization rate, and average revenue per booking.',
        es:  'La tabla de Rendimiento por Vehículo desglosa cada vehículo individualmente: conteo de reservas, ingresos brutos y netos, gastos, ganancia, retorno de inversión, ganancia mensual, período de recuperación, tasa de utilización e ingreso promedio por reserva.',
      },
      {
        sel: null,
        en:  'That is the Fleet Analytics section.',
        es:  'Esa es la sección de Analítica de Flota.',
      },
    ],
    customers: [
      {
        sel: '#page-customers',
        en:  'The Customers page shows every renter who has ever booked with you. ' +
             'Use the search bar at the top to find someone by name, phone, or email.',
        es:  'La página de Clientes muestra a todos los arrendatarios que alguna vez han reservado con usted. ' +
             'Use la barra de búsqueda en la parte superior para encontrar a alguien por nombre, teléfono o correo.',
      },
      {
        sel: '#page-customers',
        en:  'The filter row has four controls: a status filter to show all customers or narrow to flagged, banned, or active only; ' +
             'a risk level filter to view low, medium, or high risk renters; ' +
             'and a sort dropdown to order the list by total spent, profit, number of bookings, last booking date, no-show count, or name.',
        es:  'La fila de filtros tiene cuatro controles: un filtro de estado para ver todos los clientes o reducir a marcados, prohibidos o activos; ' +
             'un filtro de nivel de riesgo para ver arrendatarios de bajo, medio o alto riesgo; ' +
             'y un menú de ordenación para clasificar por total gastado, ganancia, número de reservas, última reserva, conteo de no-shows o nombre.',
      },
      {
        sel: '#page-customers',
        en:  'The Recompute Totals button recalculates all customer KPI figures — total spent, profit, bookings count — from the revenue records. ' +
             'Run this after syncing revenue to make sure the customer stats are up to date. ' +
             'The Add Customer button lets you manually create a customer record without requiring them to book first.',
        es:  'El botón Recalcular Totales recalcula todas las cifras KPI de los clientes — total gastado, ganancia, conteo de reservas — a partir de los registros de ingresos. ' +
             'Úselo después de sincronizar ingresos para asegurar que las estadísticas estén actualizadas. ' +
             'El botón Agregar Cliente le permite crear manualmente un registro de cliente sin necesidad de que hagan una reserva primero.',
      },
      {
        sel: '#cust-kpi-grid',
        en:  'The KPI tiles below the toolbar summarize fleet-wide customer metrics: total customers, average revenue per customer, total flagged, and total banned.',
        es:  'Los mosaicos KPI debajo de la barra de herramientas resumen las métricas de clientes de toda la flota: clientes totales, ingreso promedio por cliente, total marcados y total prohibidos.',
      },
      {
        sel: '#page-customers',
        en:  'The customer table shows name, contact info, total bookings, total spent, profit generated, no-show count, last booking date, customer tier, and status. ' +
             'Each row has four action buttons: ' +
             'View opens a detailed profile with full booking history. ' +
             'Bookings jumps directly to that customer\'s bookings in the Bookings section. ' +
             'Edit opens a form to update their contact details. ' +
             'Flag marks them for closer monitoring. ' +
             'Ban blocks them from making any future bookings.',
        es:  'La tabla de clientes muestra nombre, información de contacto, reservas totales, total gastado, ganancia generada, conteo de no-shows, última reserva, nivel de cliente y estado. ' +
             'Cada fila tiene cuatro botones de acción: ' +
             'Ver abre un perfil detallado con historial completo de reservas. ' +
             'Reservas salta directamente a las reservas de ese cliente en la sección de Reservas. ' +
             'Editar abre un formulario para actualizar sus datos de contacto. ' +
             'Marcar los señala para mayor supervisión. ' +
             'Prohibir los bloquea de futuras reservas.',
      },
      {
        sel: null,
        en:  'That is the Customers section.',
        es:  'Esa es la sección de Clientes.',
      },
    ],
    'protection-plans': [
      {
        sel: '#page-protection-plans',
        en:  'Protection Plans lets you configure the insurance and coverage options ' +
             'offered to customers during the booking checkout.',
        es:  'Planes de Protección le permite configurar las opciones de seguro y cobertura ' +
             'ofrecidas a los clientes durante el proceso de reserva.',
      },
      {
        sel: '#page-protection-plans',
        en:  'The Add Plan button at the top opens a form where you can define a plan name, description, daily price, and what is covered. ' +
             'Customers will see these plans and can select one when booking a vehicle.',
        es:  'El botón Agregar Plan en la parte superior abre un formulario para definir nombre del plan, descripción, precio diario y cobertura. ' +
             'Los clientes verán estos planes y podrán seleccionar uno al reservar un vehículo.',
      },
      {
        sel: '#page-protection-plans',
        en:  'Each existing plan has an Edit button to update its details and a Delete button to remove it from the checkout options.',
        es:  'Cada plan existente tiene un botón Editar para actualizar sus detalles y un botón Eliminar para quitarlo de las opciones de reserva.',
      },
      {
        sel: null,
        en:  'That is the Protection Plans section.',
        es:  'Esa es la sección de Planes de Protección.',
      },
    ],
    'vehicle-pricing': [
      {
        sel: '#page-vehicle-pricing',
        en:  'Vehicle Pricing is where you control exactly what customers pay. ' +
             'For each vehicle you can set the daily rate, the weekly rate, the security deposit amount, and the tax rate.',
        es:  'Precios de Vehículos es donde controla exactamente lo que pagan los clientes. ' +
             'Para cada vehículo puede establecer la tarifa diaria, tarifa semanal, monto del depósito y tasa de impuesto.',
      },
      {
        sel: '#page-vehicle-pricing',
        en:  'Each vehicle has its own pricing card with editable fields — each vehicle is saved individually. ' +
             'After updating the values for a vehicle, click the Save Pricing button on that specific vehicle\'s card to apply the changes for that car. ' +
             'The new rates take effect immediately on the very next booking — no restart needed. ' +
             'All four booking paths — online, manual, extensions, and balance payments — pull from these saved values.',
        es:  'Cada vehículo tiene su propia tarjeta de precios con campos editables — cada vehículo se guarda de forma individual. ' +
             'Después de actualizar los valores de un vehículo, haga clic en el botón Guardar Precios en la tarjeta de ese vehículo específico para aplicar los cambios de ese auto. ' +
             'Las nuevas tarifas surten efecto inmediatamente en la próxima reserva, sin necesidad de reinicio. ' +
             'Las cuatro rutas de reserva — en línea, manual, extensiones y pagos de saldo — utilizan estos valores guardados.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Pricing section.',
        es:  'Esa es la sección de Precios de Vehículos.',
      },
    ],
    'system-settings': [
      {
        sel: '#page-system-settings',
        en:  'System Settings is where you configure the global behavior of the entire platform. ' +
             'It is organized into several sections that control automation, notifications, integrations, and more.',
        es:  'Configuración del Sistema es donde configura el comportamiento global de toda la plataforma. ' +
             'Está organizada en varias secciones que controlan automatización, notificaciones, integraciones y más.',
      },
      {
        sel: '#sys-settings-content',
        en:  'In the automation section you can toggle whether the system automatically sends booking confirmation SMS messages, ' +
             'pickup reminders, return reminders, and late fee alerts.',
        es:  'En la sección de automatización puede activar o desactivar el envío automático de SMS de confirmación de reserva, ' +
             'recordatorios de recogida, recordatorios de devolución y alertas de cargo por mora.',
      },
      {
        sel: '#sys-settings-content',
        en:  'The tax and fee settings let you set the default sales tax rate applied to all bookings, ' +
             'and configure late fee amounts and grace periods.',
        es:  'Los ajustes de impuestos y tarifas permiten establecer la tasa de impuesto predeterminada aplicada a todas las reservas ' +
             'y configurar los montos y períodos de gracia de los cargos por mora.',
      },
      {
        sel: '#bouncie-auth-content',
        en:  'The Bouncie GPS section lets you connect your Bouncie account using your client ID and secret. ' +
             'Once connected, GPS Tracking will show live vehicle locations.',
        es:  'La sección de GPS Bouncie le permite conectar su cuenta de Bouncie usando su ID de cliente y clave secreta. ' +
             'Una vez conectado, el Rastreo GPS mostrará las ubicaciones en vivo de los vehículos.',
      },
      {
        sel: null,
        en:  'That is the System Settings section.',
        es:  'Esa es la sección de Configuración del Sistema.',
      },
    ],
    'late-fees': [
      {
        sel: '#page-late-fees',
        en:  'The Late Fees section tracks all overdue charges automatically calculated when a rental runs past its return date.',
        es:  'La sección de Cargos por Mora rastrea todos los cargos de vencimiento calculados automáticamente cuando una renta supera su fecha de devolución.',
      },
      {
        sel: '#page-late-fees',
        en:  'Use the filter dropdowns at the top to view fees by status — Pending, Approved, Paid, Failed, or Dismissed — ' +
             'and by vehicle. The search box finds fees by customer name or booking ID.',
        es:  'Use los filtros en la parte superior para ver cargos por estado — Pendiente, Aprobado, Pagado, Fallido o Descartado — ' +
             'y por vehículo. La búsqueda encuentra cargos por nombre de cliente o ID de reserva.',
      },
      {
        sel: '#page-late-fees',
        en:  'Each row has action buttons: ' +
             'Approve marks the fee as approved and ready to collect. ' +
             'Charge attempts to bill the customer\'s card on file via Stripe. ' +
             'Waive cancels the fee with no charge. ' +
             'Edit lets you adjust the amount. ' +
             'Dismiss removes the fee from the active list.',
        es:  'Cada fila tiene botones de acción: ' +
             'Aprobar marca el cargo como aprobado y listo para cobrar. ' +
             'Cobrar intenta cargar la tarjeta del cliente en Stripe. ' +
             'Eximir cancela el cargo sin cobro. ' +
             'Editar permite ajustar el monto. ' +
             'Descartar elimina el cargo de la lista activa.',
      },
      {
        sel: null,
        en:  'That is the Late Fees section.',
        es:  'Esa es la sección de Cargos por Mora.',
      },
    ],
    sms: [
      {
        sel: '#page-sms',
        en:  'SMS Automation shows all the automated text message templates sent to customers throughout their rental journey.',
        es:  'Automatización de SMS muestra todas las plantillas de mensajes de texto automáticos enviados a los clientes durante su proceso de renta.',
      },
      {
        sel: '#page-sms',
        en:  'Each template has a specific purpose: ' +
             'the booking confirmation SMS is sent immediately after a successful payment. ' +
             'The pickup reminder goes out the day before the rental starts. ' +
             'The return reminder is sent the day before the scheduled return date. ' +
             'The late fee notice is sent when the vehicle is overdue.',
        es:  'Cada plantilla tiene un propósito específico: ' +
             'el SMS de confirmación de reserva se envía inmediatamente después de un pago exitoso. ' +
             'El recordatorio de recogida se envía el día anterior al inicio de la renta. ' +
             'El recordatorio de devolución se envía el día antes de la fecha de devolución programada. ' +
             'El aviso de cargo por mora se envía cuando el vehículo está vencido.',
      },
      {
        sel: '#page-sms',
        en:  'Each template has an Edit button that opens a panel where you can rewrite the message text and use placeholder variables ' +
             'like the customer name, vehicle name, pickup date, or return date — these are filled in automatically when the SMS is sent.',
        es:  'Cada plantilla tiene un botón Editar que abre un panel donde puede reescribir el texto del mensaje y usar variables de marcador ' +
             'como nombre del cliente, nombre del vehículo, fecha de recogida o devolución — estas se completan automáticamente al enviar el SMS.',
      },
      {
        sel: null,
        en:  'That is the SMS Automation section.',
        es:  'Esa es la sección de Automatización de SMS.',
      },
    ],
    ai: [
      {
        sel: '#page-ai',
        en:  'The AI Assistant is a full conversational interface powered by artificial intelligence. ' +
             'Type any question or command in the chat box and the assistant responds with detailed, intelligent answers.',
        es:  'El Asistente IA es una interfaz conversacional completa impulsada por inteligencia artificial. ' +
             'Escriba cualquier pregunta o comando en el cuadro de chat y el asistente responde con respuestas detalladas e inteligentes.',
      },
      {
        sel: '#ai-chips',
        en:  'The quick-action chips above the input box give you one-tap shortcuts to common questions: ' +
             'This week\'s revenue, Booking analysis to understand why bookings may be low, ' +
             'Active rentals, Fraud check on recent bookings, and Fleet mileage and maintenance status. ' +
             'Tap any chip and the AI answers immediately.',
        es:  'Los chips de acceso rápido encima del cuadro de entrada dan atajos de un toque para preguntas comunes: ' +
             'Ingresos de esta semana, Análisis de reservas para entender por qué pueden ser bajas, ' +
             'Rentas activas, Verificación de fraude en reservas recientes y Estado de kilometraje y mantenimiento de la flota. ' +
             'Toque cualquier chip y la IA responde de inmediato.',
      },
      {
        sel: '#page-ai',
        en:  'In the chat input row there are three controls: ' +
             'The paperclip Attach button lets you upload an image — for example a photo of damage or a document — and ask the AI about it. ' +
             'The text input box is where you type your question or command. ' +
             'The Send button submits your message. You can also press Enter to send.',
        es:  'En la fila de entrada del chat hay tres controles: ' +
             'El botón de Adjuntar con ícono de clip le permite subir una imagen, por ejemplo una foto de daño o un documento, y preguntarle a la IA sobre ella. ' +
             'El cuadro de texto es donde escribe su pregunta o comando. ' +
             'El botón Enviar envía su mensaje. También puede presionar Enter para enviar.',
      },
      {
        sel: '#page-ai',
        en:  'In the top-right of the chat header you have two more controls: ' +
             'New Chat clears the conversation history so you can start a fresh session. ' +
             'The Auto Mode toggle enables the AI to take actions automatically without asking for confirmation — ' +
             'for example creating a booking or updating a record directly. Turn it off if you want the AI to ask before acting.',
        es:  'En la parte superior derecha del encabezado del chat hay dos controles más: ' +
             'Nuevo Chat limpia el historial de conversación para comenzar una sesión nueva. ' +
             'El interruptor de Modo Automático permite a la IA tomar acciones automáticamente sin pedir confirmación, ' +
             'por ejemplo crear una reserva o actualizar un registro directamente. Desactívelo si prefiere que la IA pregunte antes de actuar.',
      },
      {
        sel: '#ai-side-panel',
        en:  'On the right side of the AI page are three auto-loading insight panels. ' +
             'Revenue Snapshot shows a quick summary of this week\'s income. ' +
             'Detected Problems automatically scans your data for anomalies like missing revenue records, overdue bookings, or booking integrity issues. ' +
             'Fraud Monitor scans recent bookings for suspicious patterns such as duplicate contacts, unusually short rentals, or high-risk indicators.',
        es:  'En el lado derecho de la página de IA hay tres paneles de insights que se cargan automáticamente. ' +
             'Resumen de Ingresos muestra un resumen rápido de los ingresos de esta semana. ' +
             'Problemas Detectados escanea automáticamente sus datos en busca de anomalías como registros de ingresos faltantes, reservas vencidas o problemas de integridad. ' +
             'Monitor de Fraude escanea las reservas recientes en busca de patrones sospechosos como contactos duplicados, rentas inusualmente cortas o indicadores de alto riesgo.',
      },
      {
        sel: null,
        en:  'That is the AI Assistant section.',
        es:  'Esa es la sección del Asistente IA.',
      },
    ],
    'system-health': [
      {
        sel: '#page-system-health',
        en:  'System Health is your diagnostic center. It verifies the integrity of your entire platform: ' +
             'payments, bookings, revenue records, agreement PDFs, and active rental counts.',
        es:  'Salud del Sistema es su centro de diagnóstico. Verifica la integridad de toda la plataforma: ' +
             'pagos, reservas, registros de ingresos, PDFs de acuerdos y conteos de rentas activas.',
      },
      {
        sel: '#page-system-health',
        en:  'The Run Checks button at the top triggers all diagnostic checks at once. ' +
             'Each check shows either a green pass, a yellow warning, or a red failure with a description of the issue.',
        es:  'El botón Ejecutar Comprobaciones en la parte superior activa todos los diagnósticos a la vez. ' +
             'Cada comprobación muestra un resultado verde de aprobado, amarillo de advertencia, o rojo de falla con descripción del problema.',
      },
      {
        sel: '#page-system-health',
        en:  'At the bottom of System Health is the SMS Logs section. ' +
             'It shows the last one hundred SMS delivery attempts with time, booking reference, vehicle, phone number, message type, delivery status, and any error message. ' +
             'The Refresh button reloads the logs, and the Clear button removes old entries.',
        es:  'En la parte inferior de Salud del Sistema está la sección de Registros de SMS. ' +
             'Muestra los últimos cien intentos de entrega de SMS con hora, referencia de reserva, vehículo, teléfono, tipo de mensaje, estado de entrega y cualquier error. ' +
             'El botón Actualizar recarga los registros y el botón Limpiar elimina entradas antiguas.',
      },
      {
        sel: null,
        en:  'That is the System Health section.',
        es:  'Esa es la sección de Salud del Sistema.',
      },
    ],
    settings: [
      {
        sel: '#page-settings',
        en:  'The Settings page has three main sections: Admin Access, Site Content, and System Diagnostics.',
        es:  'La página de Configuración tiene tres secciones principales: Acceso de Administrador, Contenido del Sitio y Diagnósticos del Sistema.',
      },
      {
        sel: '#page-settings',
        en:  'The Admin Access section explains how to change your admin password. ' +
             'Because the password is an environment variable, you update it in your Vercel dashboard — ' +
             'the form here is a reference guide to remind you where to go.',
        es:  'La sección de Acceso de Administrador explica cómo cambiar su contraseña de administrador. ' +
             'Como la contraseña es una variable de entorno, la actualiza en su panel de Vercel — ' +
             'el formulario aquí es una guía de referencia.',
      },
      {
        sel: '#site-content-form',
        en:  'The Site Content section controls everything visible on your public website. ' +
             'You can update your business name, phone, WhatsApp, and email. ' +
             'You can also upload or change your logo — the new logo appears on every public page immediately.',
        es:  'La sección de Contenido del Sitio controla todo lo visible en su sitio web público. ' +
             'Puede actualizar el nombre del negocio, teléfono, WhatsApp y correo electrónico. ' +
             'También puede subir o cambiar su logo, que aparece en cada página pública de inmediato.',
      },
      {
        sel: '#site-content-form',
        en:  'Further down in Site Content you can edit the hero title and subtitle that appear on the homepage, ' +
             'the About Us paragraph, social media links for Instagram, Facebook, TikTok, and Twitter, ' +
             'a promotional banner that can be toggled on or off, ' +
             'and your cancellation, damage, fuel, and age policies.',
        es:  'Más abajo en Contenido del Sitio puede editar el título y subtítulo del hero de la página principal, ' +
             'el párrafo de Acerca de Nosotros, enlaces de redes sociales para Instagram, Facebook, TikTok y Twitter, ' +
             'un banner promocional que se puede activar o desactivar, ' +
             'y sus políticas de cancelación, daños, combustible y edad.',
      },
      {
        sel: '#site-content-form',
        en:  'The Save All Changes button publishes all your site content edits to the live website instantly. ' +
             'The Refresh button reloads the current saved values.',
        es:  'El botón Guardar Todos los Cambios publica todas sus ediciones de contenido al sitio web en vivo de inmediato. ' +
             'El botón Actualizar recarga los valores guardados actualmente.',
      },
      {
        sel: '#run-diagnostics-btn',
        en:  'The System Diagnostics section at the bottom has a Run Check button that verifies all required environment variables are configured ' +
             'and that all necessary Supabase database tables exist. Run this if you ever see errors in the admin panel.',
        es:  'La sección de Diagnósticos del Sistema al fondo tiene un botón Ejecutar Comprobación que verifica que todas las variables de entorno requeridas estén configuradas ' +
             'y que todas las tablas de base de datos de Supabase necesarias existan. Úselo si ve errores en el panel de administración.',
      },
      {
        sel: null,
        en:  'That is the Settings section.',
        es:  'Esa es la sección de Configuración.',
      },
    ],
  };

  // Pages visited (in order) during the Full System Tour.
  // Matches the sidebar order: Dashboard → Vehicles → Bookings → Raw Bookings →
  // Manual Booking → Fleet Status → GPS → Block Dates → Expenses → Revenue →
  // Fleet Analytics → Customers → Protection Plans → Vehicle Pricing →
  // System Settings → Late Fees → SMS Automation → AI Assistant →
  // System Health → Settings
  const FULL_TOUR_PAGES = [
    'dashboard',
    'vehicles',
    'bookings',
    'bookings-raw',
    'manual-booking',
    'fleet-status',
    'gps',
    'block-dates',
    'expenses',
    'revenue',
    'analytics',
    'customers',
    'protection-plans',
    'vehicle-pricing',
    'system-settings',
    'late-fees',
    'sms',
    'ai',
    'system-health',
    'settings',
  ];

  // Closing line spoken at the end of the Full System Tour.
  const FULL_TOUR_CLOSING = {
    en: `That completes the full system tour — all ${FULL_TOUR_PAGES.length} sections covered, from Dashboard to Settings. ` +
        'You can revisit any section guide from the Voice Assistant panel, or ask a question using Ask Assistant.',
    es: `Eso completa el recorrido completo del sistema — las ${FULL_TOUR_PAGES.length} secciones cubiertas, desde el Tablero hasta Configuración. ` +
        'Puede revisar la guía de cualquier sección desde el Panel del Asistente de Voz, o hacer una pregunta usando Preguntar al Asistente.',
  };

  // ── Runtime state ─────────────────────────────────────────────────────────
  let currentAudio    = null;     // HTMLAudioElement currently playing
  let currentBlobUrl  = null;     // blob URL for the current audio (to revoke)
  let isSpeaking      = false;
  let isPaused        = false;
  let tourActive      = false;
  let tourStepIndex   = 0;
  let tourAborted     = false;
  let clickExplain    = false;    // context-aware click-explain toggle
  let lastClickTime   = 0;        // debounce tracker for click-explain
  // AbortController for the currently in-flight click-explain fetch.
  // A new eligible click aborts the previous one before starting fresh.
  let explainController = null;
  // Resolve callback exposed so stopTour() can immediately unblock waitForModalOpen.
  let tourWaitResolve = null;
  // Numeric priority of the audio currently playing (0 = nothing playing).
  let currentSpeakPriority = 0;
  // Session-level memory: updated by vaUpdateContext() whenever the admin opens a booking.
  // Persists across modal open/close cycles so AI prompts stay contextually aware of the
  // last booking the admin focused on, even after the detail modal is dismissed.
  // Also auto-updated by initContextObservers() via MutationObserver.
  const sessionCtx = {
    bookingId:  null,   // last viewed booking ID
    vehicle:    null,   // vehicle name from last viewed booking
    status:     null,   // booking status from last viewed booking
    customer:   null,   // customer name from last viewed customer detail
    lastAction: null,   // text of the most recent successful action toast
  };
  let lang            = VALID_LANGS.includes(localStorage.getItem(LANG_STORAGE))
                          ? localStorage.getItem(LANG_STORAGE)
                          : 'en';
  let muted           = localStorage.getItem(MUTE_STORAGE) === 'true';
  let panelHidden     = localStorage.getItem(HIDE_STORAGE) === 'true';

  // TTS cache: Map<`${lang}:${text}`, ArrayBuffer>
  // Used for both fixed tour phrases (pre-warmed) and repeated assistant replies.
  const ttsCache = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getApiBase() {
    return (typeof API_BASE !== 'undefined') ? API_BASE : '';
  }

  function getAdminSecret() {
    return (typeof adminSecret !== 'undefined') ? adminSecret : '';
  }

  /** Evict the oldest TTS cache entry when capacity is reached. */
  function evictOldestCacheEntry() {
    if (ttsCache.size >= TTS_CACHE_MAX) {
      ttsCache.delete(ttsCache.keys().next().value);
    }
  }

  /** Returns the currently active section label (prefers an open modal). */
  function getCurrentSection() {
    // Check if any known modal is open
    for (const [modalId, labels] of Object.entries(MODAL_SECTION)) {
      const el = document.getElementById(modalId);
      if (el && el.classList.contains('open')) {
        return labels[lang] || labels.en;
      }
    }
    // Fall back to the current page
    const page = (typeof currentPage !== 'undefined') ? currentPage : '';
    const entry = SECTION_LABELS[page];
    if (entry) return entry[lang] || entry.en;
    // Last-resort: read the live page title element so future sections are always named
    const titleEl = document.getElementById('page-title');
    if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();
    return page || 'Admin Dashboard';
  }

  /**
   * Return the currently active page key (matches navigate() / currentPage global).
   * Reads the `currentPage` global first; falls back to inspecting the active .page element.
   */
  function getActivePage() {
    if (typeof currentPage !== 'undefined' && currentPage && currentPage !== 'undefined') return currentPage;
    const active = document.querySelector('.page.active');
    if (active && active.id) return active.id.replace(/^page-/, '');
    return 'dashboard';
  }

  /**
   * Returns true when `el` exists and has a non-zero bounding box.
   * Used to skip tour steps whose target element is not rendered yet.
   */
  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  /**
   * Scrape vehicle name and booking status from the open booking-detail-modal.
   * Returns an object with `vehicle` and/or `status` strings, or null if the
   * modal is not open or the detail grid cannot be found.
   */
  function getBookingContext() {
    const modal = document.getElementById('booking-detail-modal');
    if (!modal || !modal.classList.contains('open')) return null;

    const grid = modal.querySelector('.detail-grid');
    if (!grid) return null;

    const ctx = {};
    const cells = grid.querySelectorAll(':scope > div');

    for (const cell of cells) {
      const children = cell.children;
      if (children.length < 2) continue;
      const labelText = children[0].textContent.trim().toLowerCase();
      // Use textContent so HTML badges (spans) are reduced to plain text.
      const valueText = children[children.length - 1].textContent
        .replace(/\s+/g, ' ').trim();
      if (!valueText) continue;

      if (labelText === 'vehicle')  ctx.vehicle = valueText;
      else if (labelText === 'status')  ctx.status  = valueText;
    }

    return (ctx.vehicle || ctx.status) ? ctx : null;
  }

  /**
   * Build a compact session-context suffix for AI prompts.
   * Uses the persisted sessionCtx object (auto-updated by MutationObserver whenever
   * the admin navigates, opens a modal, or completes an action) so the AI always
   * knows what the admin last did and was looking at.
   */
  function buildSessionContextLine() {
    const parts = [];
    if (sessionCtx.section)    parts.push(`current section: ${sessionCtx.section}`);
    if (sessionCtx.vehicle)    parts.push(`vehicle: ${sessionCtx.vehicle}`);
    if (sessionCtx.status)     parts.push(`status: ${sessionCtx.status}`);
    if (sessionCtx.bookingId)  parts.push(`booking: ${sessionCtx.bookingId}`);
    if (sessionCtx.customer)   parts.push(`customer: ${sessionCtx.customer}`);
    if (sessionCtx.lastAction) parts.push(`last action: ${sessionCtx.lastAction}`);
    return parts.length ? ` Session context — ${parts.join(', ')}.` : '';
  }

  function setLang(l) {
    lang = VALID_LANGS.includes(l) ? l : 'en';
    localStorage.setItem(LANG_STORAGE, lang);
    updatePanelState();
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem(MUTE_STORAGE, String(m));
    if (m) stopAudio();
    updatePanelState();
  }

  function setPanelHidden(hidden) {
    panelHidden = hidden;
    localStorage.setItem(HIDE_STORAGE, String(hidden));
    const panel  = document.getElementById(PANEL_ID);
    const bubble = document.getElementById(BUBBLE_ID);
    if (panel)  panel.style.display  = hidden ? 'none'  : 'flex';
    if (bubble) bubble.style.display = hidden ? 'flex'  : 'none';
  }

  function updatePanelState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const langBtn      = panel.querySelector('#va-lang-btn');
    const muteBtn      = panel.querySelector('#va-mute-btn');
    const explBtn      = panel.querySelector('#va-expl-btn');
    const stopBtn      = panel.querySelector('#va-stop-btn');
    const pauseBtn     = panel.querySelector('#va-pause-btn');
    const tourBtn      = panel.querySelector('#va-tour-btn');
    const fullTourBtn  = panel.querySelector('#va-fulltour-btn');

    if (langBtn)     langBtn.textContent     = lang === 'en' ? '🌎 EN' : '🌎 ES';
    if (muteBtn)     muteBtn.textContent     = muted ? '🔇 Muted' : '🔊 Sound On';
    if (explBtn)     explBtn.style.opacity   = clickExplain ? '1' : '0.55';
    if (stopBtn)     stopBtn.disabled        = !isSpeaking && !tourActive;
    if (pauseBtn) {
      pauseBtn.disabled    = !isSpeaking;
      pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      pauseBtn.style.color = isSpeaking ? '#fff' : '#9ca3af';
    }
    if (tourBtn)     tourBtn.textContent     = tourActive ? '⏹ Stop Guide'  : '📍 Page Guide';
    if (fullTourBtn) fullTourBtn.textContent = tourActive ? '⏹ Stop Tour'   : '🚀 Full Tour';
  }

  // ── Audio stop ─────────────────────────────────────────────────────────────
  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio = null;
    }
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    isSpeaking = false;
    isPaused   = false;
    currentSpeakPriority = 0;
    updatePanelState();
  }

  // ── Audio pause / resume ───────────────────────────────────────────────────
  function pauseAudio() {
    if (currentAudio && isSpeaking && !isPaused) {
      currentAudio.pause();
      isPaused = true;
      updatePanelState();
    }
  }

  function resumeAudio() {
    if (currentAudio && isSpeaking && isPaused) {
      currentAudio.play().catch(() => {});
      isPaused = false;
      updatePanelState();
    }
  }

  function togglePause() {
    if (isPaused) resumeAudio();
    else          pauseAudio();
  }

  // ── Core TTS ───────────────────────────────────────────────────────────────
  /**
   * Fetch TTS audio into the cache without playing it.
   * Silently ignores errors — cache misses just cause a live fetch at speak() time.
   */
  async function prefetchTts(text, speakLang) {
    speakLang = speakLang || lang;
    const cacheKey = `${speakLang}:${text}`;
    if (ttsCache.has(cacheKey)) return;

    try {
      const res = await fetch(`${getApiBase()}/api/tts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, lang: speakLang, secret: getAdminSecret() }),
      });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      evictOldestCacheEntry();
      ttsCache.set(cacheKey, buf);
    } catch (_) { /* ignore */ }
  }

  /**
   * Pre-warm the TTS cache for the current page's tour steps and all Full Tour
   * step scripts in both languages.  Called eagerly on init so tour playback
   * is nearly instant.
   */
  async function prewarmTourCache() {
    const secret = getAdminSecret();
    if (!secret) return; // not authenticated yet; tour will fetch live
    const texts = [];

    // Pre-warm steps for the page the admin is currently on
    const pageSteps = PAGE_TOUR_STEPS[getActivePage()] || [];
    for (const step of pageSteps) {
      if (step.en) texts.push([step.en, 'en']);
      if (step.es) texts.push([step.es, 'es']);
    }

    // Pre-warm first step of each Full Tour page (the introductory line)
    for (const page of FULL_TOUR_PAGES) {
      const steps = PAGE_TOUR_STEPS[page] || [];
      if (steps.length) {
        if (steps[0].en) texts.push([steps[0].en, 'en']);
        if (steps[0].es) texts.push([steps[0].es, 'es']);
      }
    }

    // Pre-warm the Full Tour closing line
    if (FULL_TOUR_CLOSING.en) texts.push([FULL_TOUR_CLOSING.en, 'en']);
    if (FULL_TOUR_CLOSING.es) texts.push([FULL_TOUR_CLOSING.es, 'es']);

    // Fire all fetches concurrently; failures are silently ignored
    await Promise.allSettled(texts.map(([t, l]) => prefetchTts(t, l)));
  }

  /**
   * Speak text aloud using /api/tts.
   * Returns a Promise that resolves when playback finishes.
   *
   * @param {string}  text
   * @param {string}  [speakLang]    — defaults to current `lang`
   * @param {number}  [priority]     — one of PRIORITY.*; lower-priority calls are
   *                                   silently dropped when something higher is playing
   */
  async function speak(text, speakLang, priority) {
    if (muted || !text) return;

    const p = (priority !== undefined) ? priority : PRIORITY.assistant;
    // Respect priority — never interrupt a higher-priority stream.
    if (isSpeaking && p < currentSpeakPriority) return;

    speakLang = speakLang || lang;
    const cacheKey = `${speakLang}:${text}`;

    stopAudio();
    isSpeaking = true;
    currentSpeakPriority = p;
    updatePanelState();

    try {
      let audioBuffer;

      if (ttsCache.has(cacheKey)) {
        audioBuffer = ttsCache.get(cacheKey);
      } else {
        const res = await fetch(`${getApiBase()}/api/tts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text, lang: speakLang, secret: getAdminSecret() }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `TTS error ${res.status}`);
        }

        audioBuffer = await res.arrayBuffer();
        evictOldestCacheEntry();
        ttsCache.set(cacheKey, audioBuffer);
      }

      const blob     = new Blob([audioBuffer], { type: 'audio/mpeg' });
      const blobUrl  = URL.createObjectURL(blob);
      currentBlobUrl = blobUrl;
      const audio    = new Audio(blobUrl);
      currentAudio   = audio;

      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = reject;
        audio.play().catch(reject);
      });
    } catch (err) {
      console.warn('[VoiceAssistant] speak error:', err);
    } finally {
      stopAudio();
    }
  }

  // ── Highlight helper ───────────────────────────────────────────────────────
  function highlightElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline       = '3px solid #2563eb';
    el.style.outlineOffset = '3px';
    el.style.borderRadius  = '6px';
    el.style.transition    = 'outline 0.3s';
    setTimeout(() => {
      el.style.outline       = '';
      el.style.outlineOffset = '';
    }, MAX_HIGHLIGHT);
  }

  // ── Modal wait helper (MutationObserver) ───────────────────────────────────
  /**
   * Returns a Promise that resolves when the element matching `selector` has
   * the class `open` added to it, or rejects after `timeoutMs`.
   * The tour calls this to pause until the user clicks "View" and the modal opens.
   */
  function waitForModalOpen(selector, timeoutMs = MAX_MODAL_WAIT_MS) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (!el) { reject(new Error(`Element not found: ${selector}`)); return; }

      // Already open
      if (el.classList.contains('open')) { tourWaitResolve = null; resolve(); return; }

      const cleanup = () => {
        clearTimeout(timer);
        obs.disconnect();
        tourWaitResolve = null;
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for modal'));
      }, timeoutMs);

      const obs = new MutationObserver(() => {
        if (el.classList.contains('open')) {
          cleanup();
          resolve();
        }
      });

      // Expose a resolve hook so stopTour() can unblock this wait immediately.
      tourWaitResolve = () => { cleanup(); resolve(); };

      obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // ── Guided Tour (current page) ─────────────────────────────────────────────
  /**
   * Start a guide for the page the admin is currently viewing.
   * No forced navigation — the tour always matches the visible UI.
   * For each step: the target element must exist and be visible; otherwise the
   * step is skipped automatically.
   */
  async function startTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

    const page  = getActivePage();
    const steps = PAGE_TOUR_STEPS[page] || buildGenericPageSteps(page);

    for (let i = 0; i < steps.length; i++) {
      if (tourAborted) break;
      tourStepIndex = i;

      const step = steps[i];
      const el   = step.sel ? document.querySelector(step.sel) : null;

      // Skip any step whose target element is specified but not visible
      if (step.sel && !isElementVisible(el)) continue;

      if (el) highlightElement(el);
      await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);

      if (tourAborted) break;

      // If this step requires a user action (e.g. click View to open modal),
      // pause here and wait for the target modal to gain the .open class.
      if (step.waitForModal && !tourAborted) {
        try {
          await waitForModalOpen(step.waitForModal);
        } catch (_) {
          // Timeout or element missing — continue tour anyway
        }
        if (tourAborted) break;
        // Small delay so the modal animation finishes before highlighting
        await new Promise(r => setTimeout(r, 400));
      }
    }

    tourActive    = false;
    tourStepIndex = 0;
    updatePanelState();
  }

  // ── Full System Tour ───────────────────────────────────────────────────────
  /**
   * Navigate through all major pages in order, speaking each page's tour steps.
   * Designed for demos and onboarding.  The tour moves to the next page once all
   * visible steps for the current page have been spoken.
   */
  async function startFullTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

    // Opening announcement
    await speak(
      lang === 'es'
        ? 'Iniciando el Recorrido Completo. Navegando por todas las secciones principales.'
        : 'Starting the Full System Tour. Navigating through all major sections.',
      undefined,
      PRIORITY.guide
    );

    for (let p = 0; p < FULL_TOUR_PAGES.length; p++) {
      if (tourAborted) break;
      const page = FULL_TOUR_PAGES[p];

      // Navigate to this page and give the DOM a moment to render
      if (typeof navigate === 'function') navigate(page);
      await new Promise(r => setTimeout(r, 500));
      if (tourAborted) break;

      const steps = PAGE_TOUR_STEPS[page] || [];
      for (let i = 0; i < steps.length; i++) {
        if (tourAborted) break;
        tourStepIndex = i;

        const step = steps[i];

        // In the full tour, skip the per-page closing null-sel step so transitions
        // feel fluid (the next page's intro immediately follows).
        if (!step.sel && i === steps.length - 1 && p < FULL_TOUR_PAGES.length - 1) continue;

        // In the full tour, steps that require user interaction (waitForModal) are
        // replaced by their fullTourEn/fullTourEs text if available, then skipped.
        // This keeps the automated demo flowing without dead silence or user prompts.
        if (step.waitForModal) {
          const fullText = lang === 'es' ? step.fullTourEs : step.fullTourEn;
          if (fullText) await speak(fullText, undefined, PRIORITY.guide);
          continue;
        }

        const el = step.sel ? document.querySelector(step.sel) : null;
        if (step.sel && !isElementVisible(el)) continue;

        if (el) highlightElement(el);
        await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);
        if (tourAborted) break;

        if (step.waitForModal && !tourAborted) {
          try {
            await waitForModalOpen(step.waitForModal);
          } catch (_) {
            // Timeout or missing — advance anyway
          }
          if (tourAborted) break;
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }

    // Closing words
    if (!tourAborted) {
      await speak(
        lang === 'es' ? FULL_TOUR_CLOSING.es : FULL_TOUR_CLOSING.en,
        undefined,
        PRIORITY.guide
      );
    }

    tourActive    = false;
    tourStepIndex = 0;
    updatePanelState();
  }

  /**
   * Build a minimal one-step tour for pages not listed in PAGE_TOUR_STEPS.
   * Always matches whatever section the admin is on.
   */
  function buildGenericPageSteps(page) {
    const label = (SECTION_LABELS[page] && SECTION_LABELS[page][lang]) || page;
    return [
      {
        sel: `#page-${page}`,
        en:  `You are currently in the ${label} section.`,
        es:  `Actualmente se encuentra en la sección de ${label}.`,
      },
    ];
  }

  function stopTour() {
    tourAborted = true;
    // Immediately release any pending waitForModalOpen so the tour loop exits
    // without waiting up to MAX_MODAL_WAIT_MS.
    if (tourWaitResolve) { tourWaitResolve(); tourWaitResolve = null; }
    stopAudio();
    tourActive  = false;
    updatePanelState();
  }

  // ── Context-Aware Click-Explain ────────────────────────────────────────────
  /**
   * Build a context object describing what the user clicked and where.
   * Returns null if the element should not be explained.
   */
  function buildClickContext(target) {
    // Find the nearest actionable element
    const el = target.closest(
      'button, [role="button"], .btn, [data-explain], a[onclick]'
    ) || target;

    // Must have data-explain attribute OR match the keyword allow-list
    const hasAttr = el.hasAttribute('data-explain');

    const rawLabel = (el.getAttribute('data-explain') ||
                      el.textContent || el.title || el.ariaLabel || '')
      .trim()
      // Keep printable ASCII and Latin extended (U+00C0–U+024F). Strip emojis,
      // control characters, and other non-Latin Unicode to avoid sending unexpected
      // characters to the TTS API.
      .replace(/[^\x20-\x7E\u00C0-\u024F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);

    if (!rawLabel || rawLabel.length < 2) return null;
    if (/^[✕×✖⊗•·]$/.test(rawLabel)) return null;

    const labelLower = rawLabel.toLowerCase();

    if (!hasAttr) {
      const matches = EXPLAIN_KEYWORDS.some(kw => labelLower.includes(kw));
      if (!matches) return null;
    }

    const section = getCurrentSection();
    // Enrich with vehicle / status from the open booking-detail-modal when available.
    const bookingCtx = getBookingContext();
    return { element: rawLabel, section, ...bookingCtx };
  }

  /**
   * Ask the AI for a concise explanation of the clicked element in context,
   * then speak the response.
   * @param {object} context - { element, section, vehicle?, status? }
   * @param {AbortSignal} [signal] - optional AbortSignal to cancel the fetch
   */
  async function explainWithContext(context, signal) {
    const secret = getAdminSecret();
    if (!secret) return;
    // Never fire a click-explain during a guided tour — guide has absolute priority.
    if (tourActive) return;

    const langName = lang === 'es' ? 'Spanish' : 'English';

    // Build optional context lines so the AI can give a richer, specific answer.
    const extras = [];
    if (context.vehicle) extras.push(`Vehicle: ${context.vehicle}`);
    if (context.status)  extras.push(`Booking status: ${context.status}`);
    const extraLine = extras.length ? ` Additional context — ${extras.join(', ')}.` : '';

    const prompt =
      `${VOICE_PERSONA} ` +
      `The admin just clicked "${context.element}" in the "${context.section}" section.` +
      `${extraLine}` +
      `${buildSessionContextLine()} ` +
      `In exactly 1 short sentence, explain what this action does. ` +
      `Respond in ${langName}. Do not start with "This button".`;

    const messages = [{ role: 'user', content: prompt }];

    try {
      const res = await fetch(`${getApiBase()}/api/admin-chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ secret, messages }),
        signal:  signal || AbortSignal.timeout(20000),
      });

      if (!res.ok) return;
      const data  = await res.json();
      const reply = (data.reply || '').trim().slice(0, 200);
      if (reply) await speak(reply, undefined, PRIORITY.explain);
    } catch (err) {
      // AbortError is expected when a new click interrupts the previous one.
      if (err.name !== 'AbortError') {
        console.warn('[VoiceAssistant] explainWithContext error:', err);
      }
    }
  }

  // ── Click-Explain event listener ──────────────────────────────────────────
  function handleClickExplain(e) {
    if (!clickExplain || muted) return;

    // Skip clicks inside the voice panel or the ask dialog
    const panel = document.getElementById(PANEL_ID);
    if (panel && panel.contains(e.target)) return;
    const dialog = document.getElementById('va-ask-dialog');
    if (dialog && dialog.contains(e.target)) return;

    // Debounce — prevents trivial double-clicks from firing twice
    const now = Date.now();
    if (now - lastClickTime < CLICK_EXPLAIN_DEBOUNCE_MS) return;
    lastClickTime = now;

    const context = buildClickContext(e.target);
    if (!context) return;

    // Interrupt any currently in-flight explanation (fetch + audio) before
    // starting the new one.  stopAudio() cancels playback; the AbortController
    // cancels the pending fetch so the previous explain doesn't speak over the
    // new one after its network round-trip completes.
    if (explainController) {
      explainController.abort();
      stopAudio();
    }
    explainController = new AbortController();
    const { signal } = explainController;

    explainWithContext(context, signal).finally(() => {
      // Clear the controller reference once this explain finishes or is aborted.
      if (explainController && explainController.signal === signal) {
        explainController = null;
      }
    });
  }

  // ── Ask Assistant ─────────────────────────────────────────────────────────
  async function askAssistant(question) {
    if (!question || !question.trim()) return;

    const secret = getAdminSecret();
    if (!secret) {
      alert('Please sign in to the admin dashboard first.');
      return;
    }

    const section  = getCurrentSection();
    const langName = lang === 'es' ? 'Spanish' : 'English';

    const messages = [
      {
        role:    'user',
        content: `${VOICE_PERSONA} ` +
                 `The admin is currently in the "${section}" section.` +
                 `${buildSessionContextLine()} ` +
                 `Answer in 1-2 short sentences. Respond in ${langName}. ` +
                 `Question: ${question.trim()}`,
      },
    ];

    try {
      const res = await fetch(`${getApiBase()}/api/admin-chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ secret, messages }),
        signal:  AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`AI error ${res.status}`);

      const data  = await res.json();
      const reply = data.reply || '';
      if (reply) await speak(reply, undefined, PRIORITY.assistant);
    } catch (err) {
      console.warn('[VoiceAssistant] askAssistant error:', err);
      await speak(
        lang === 'es'
          ? 'Lo siento, no pude obtener una respuesta. Por favor intente de nuevo.'
          : 'Sorry, I could not get a response. Please try again.',
        undefined,
        PRIORITY.assistant
      );
    }
  }

  // ── Ask Assistant dialog ───────────────────────────────────────────────────
  function openAskDialog() {
    const existing = document.getElementById('va-ask-dialog');
    if (existing) { existing.remove(); return; }

    const dialog = document.createElement('div');
    dialog.id    = 'va-ask-dialog';
    Object.assign(dialog.style, {
      position:     'fixed',
      bottom:       '220px',
      right:        '20px',
      background:   '#1a1d27',
      border:       '1px solid #2a2d3a',
      borderRadius: '12px',
      padding:      '16px',
      width:        '280px',
      zIndex:       '10000',
      boxShadow:    '0 8px 32px rgba(0,0,0,0.4)',
    });

    const placeholder = lang === 'es' ? 'Escribe tu pregunta…' : 'Type your question…';
    const btnLabel    = lang === 'es' ? 'Preguntar' : 'Ask';
    const title       = lang === 'es' ? 'Preguntar al Asistente' : 'Ask Assistant';

    dialog.innerHTML = `
      <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">
        🎙️ ${title}
      </div>
      <textarea id="va-ask-input"
        placeholder="${placeholder}"
        rows="3"
        style="width:100%;background:#111318;border:1px solid #2d3141;border-radius:8px;
               color:#fff;font-size:13px;padding:8px;resize:none;font-family:inherit;
               box-sizing:border-box;"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="va-ask-submit"
          style="flex:1;background:#2563eb;color:#fff;border:none;border-radius:8px;
                 padding:8px;font-size:13px;font-weight:600;cursor:pointer;">
          ${btnLabel}
        </button>
        <button id="va-ask-cancel"
          style="background:#374151;color:#fff;border:none;border-radius:8px;
                 padding:8px 12px;font-size:13px;cursor:pointer;">✕</button>
      </div>
    `;

    document.body.appendChild(dialog);

    const input  = dialog.querySelector('#va-ask-input');
    const submit = dialog.querySelector('#va-ask-submit');
    const cancel = dialog.querySelector('#va-ask-cancel');

    input.focus();

    submit.addEventListener('click', async () => {
      const q = input.value.trim();
      dialog.remove();
      if (q) await askAssistant(q);
    });

    cancel.addEventListener('click', () => dialog.remove());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit.click();
      }
    });
  }

  // ── Floating Panel ────────────────────────────────────────────────────────
  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id    = PANEL_ID;
    Object.assign(panel.style, {
      position:      'fixed',
      bottom:        '20px',
      right:         '20px',
      background:    '#1a1d27',
      border:        '1px solid #2a2d3a',
      borderRadius:  '14px',
      padding:       '14px 12px',
      zIndex:        '9999',
      boxShadow:     '0 8px 32px rgba(0,0,0,0.45)',
      display:       'flex',
      flexDirection: 'column',
      gap:           '7px',
      width:         '170px',
      userSelect:    'none',
    });

    const btnStyle = `
      display:block;width:100%;padding:7px 10px;border:none;border-radius:8px;
      font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
      text-align:left;transition:opacity 0.2s;
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
        <span style="color:#9ca3af;font-size:10px;font-weight:700;letter-spacing:0.8px;
                     text-transform:uppercase;">
          Voice Assistant
        </span>
        <button id="va-hide-btn"
          title="Hide panel"
          style="background:none;border:none;cursor:pointer;color:#6b7280;font-size:14px;
                 line-height:1;padding:0 2px;font-family:inherit;">
          ✕
        </button>
      </div>
      <button id="va-tour-btn"     style="${btnStyle}background:#2563eb;color:#fff;">
        📍 Page Guide
      </button>
      <button id="va-fulltour-btn" style="${btnStyle}background:#1d4ed8;color:#fff;">
        🚀 Full Tour
      </button>
      <button id="va-ask-btn"   style="${btnStyle}background:#374151;color:#fff;">
        🎙️ Ask Assistant
      </button>
      <button id="va-expl-btn"  style="${btnStyle}background:#374151;color:#fff;opacity:0.55;">
        🖱️ Click Explain
      </button>
      <button id="va-stop-btn"  style="${btnStyle}background:#374151;color:#9ca3af;" disabled>
        ⏹ Stop
      </button>
      <button id="va-pause-btn" style="${btnStyle}background:#374151;color:#9ca3af;" disabled>
        ⏸ Pause
      </button>
      <div style="display:flex;gap:6px;margin-top:2px;">
        <button id="va-lang-btn"
          style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                 padding:6px 6px;font-size:11px;text-align:center;">
          🌎 EN
        </button>
        <button id="va-mute-btn"
          style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                 padding:6px 6px;font-size:11px;text-align:center;">
          🔊 Sound On
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Restore bubble (shown when panel is hidden) ──────────────────────────
    const bubble = document.createElement('button');
    bubble.id    = BUBBLE_ID;
    bubble.title = 'Show Voice Assistant';
    bubble.textContent = '🎙️';
    Object.assign(bubble.style, {
      position:     'fixed',
      bottom:       '20px',
      right:        '20px',
      width:        '42px',
      height:       '42px',
      borderRadius: '50%',
      background:   '#2563eb',
      border:       'none',
      color:        '#fff',
      fontSize:     '18px',
      cursor:       'pointer',
      zIndex:       '9999',
      boxShadow:    '0 4px 16px rgba(0,0,0,0.4)',
      display:      'none',
      alignItems:   'center',
      justifyContent: 'center',
    });
    document.body.appendChild(bubble);
    bubble.addEventListener('click', () => setPanelHidden(false));

    // Honour persisted hidden state on load
    if (panelHidden) {
      panel.style.display  = 'none';
      bubble.style.display = 'flex';
    }

    panel.querySelector('#va-hide-btn').addEventListener('click', () => setPanelHidden(true));

    panel.querySelector('#va-tour-btn').addEventListener('click', () => {
      if (tourActive) stopTour();
      else            startTour();
    });

    panel.querySelector('#va-fulltour-btn').addEventListener('click', () => {
      if (tourActive) stopTour();
      else            startFullTour();
    });

    panel.querySelector('#va-ask-btn').addEventListener('click', openAskDialog);

    panel.querySelector('#va-expl-btn').addEventListener('click', () => {
      clickExplain = !clickExplain;
      updatePanelState();
    });

    panel.querySelector('#va-stop-btn').addEventListener('click', () => {
      stopTour();
      stopAudio();
    });

    panel.querySelector('#va-pause-btn').addEventListener('click', togglePause);

    panel.querySelector('#va-lang-btn').addEventListener('click', () => {
      setLang(lang === 'en' ? 'es' : 'en');
    });

    panel.querySelector('#va-mute-btn').addEventListener('click', () => {
      setMuted(!muted);
    });

    updatePanelState();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    mountPanel();
    document.addEventListener('click', handleClickExplain);
    // Expose speak() globally for optional use by other scripts
    window.vaSpeak = speak;

    /**
     * Update session-level memory.  Call this whenever the admin opens a booking
     * or customer record, so subsequent AI prompts have rich context.
     * Also called automatically by initContextObservers() via MutationObserver.
     * @param {{ bookingId?: string, vehicle?: string, status?: string, customer?: string }} ctx
     */
    window.vaUpdateContext = (ctx) => {
      if (ctx && typeof ctx === 'object') Object.assign(sessionCtx, ctx);
    };

    /**
     * Speak any arbitrary confirmation text after a successful admin action.
     * Called automatically by the showToast() hook in index.html for every
     * success toast, covering all admin actions universally.
     * Strips emojis, checkmarks, and markdown before sending to TTS.
     * Also stores the cleaned text as sessionCtx.lastAction so the AI knows
     * what the most recent operation was.
     * Plays at PRIORITY.assistant — never interrupts the guided tour.
     * @param {string} text  — raw toast message
     */
    window.vaActionSpeak = (text) => {
      if (!text) return;
      // Strip leading emoji/symbols and common markdown characters; keep spoken words only.
      const clean = String(text)
        .replace(/[\u2000-\u3300\uD800-\uDFFF\u00A9\u00AE\u2122\u2139\u2194-\u2199\u21A9-\u21AA\u231A-\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA-\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614-\u2615\u2618\u261D\u2620\u2622-\u2623\u2626\u262A\u262E-\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F-\u2660\u2663\u2665-\u2666\u2668\u267B\u267E-\u267F\u2692-\u2697\u2699\u269B-\u269C\u26A0-\u26A1\u26AA-\u26AB\u26B0-\u26B1\u26BD-\u26BE\u26C4-\u26C5\u26CE-\u26CF\u26D1\u26D3-\u26D4\u26E9-\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733-\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763-\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934-\u2935\u2B05-\u2B07\u2B1B-\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]/g, '')
        .replace(/✅|✓|🚩|❌|⚠️|🔊|📧|🔁|🔄/g, '')
        .replace(/[*_`#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      if (clean.length < 3) return;
      // Always record the last action in session memory regardless of mute state.
      sessionCtx.lastAction = clean;
      if (muted) return;
      speak(clean, undefined, PRIORITY.assistant).catch((_e) => { /* non-blocking; TTS errors are silent */ });
    };

    // Pre-warm tour cache in the background; errors are silently swallowed
    prewarmTourCache().catch(() => {});
    // Start self-contained context observers so sessionCtx stays current automatically
    initContextObservers();
  }

  // ── Self-contained context observers ─────────────────────────────────────────
  /**
   * Observe the DOM for modal open/close events and navigation changes.
   * This makes the voice assistant self-contained — it automatically tracks what
   * the admin is looking at without requiring explicit vaUpdateContext() calls
   * from every action handler.  Also ensures future pages and modals added to
   * the admin are picked up immediately with no code changes required.
   */
  function initContextObservers() {
    // ── 1. Watch every .modal-overlay for class changes ───────────────────────
    // When any modal gains the `open` class, scrape its content into sessionCtx.
    const observeModal = (el) => {
      if (!el || el._vaObserved) return;
      el._vaObserved = true;
      new MutationObserver(() => {
        const isOpen = el.classList.contains('open');
        if (!isOpen) return;
        const id = el.id;

        // Booking detail: scrape vehicle, status, and booking ID
        if (id === 'booking-detail-modal') {
          const ctx = getBookingContext();
          if (ctx) Object.assign(sessionCtx, ctx);
          // Also try to read the booking ID from the modal heading or hidden field
          const refEl = el.querySelector('[data-booking-ref], #bd-booking-ref, .modal-booking-ref');
          if (refEl) sessionCtx.bookingId = refEl.textContent.trim() || refEl.value || sessionCtx.bookingId;
        }

        // Customer detail: scrape customer name
        if (id === 'customer-detail-modal') {
          const nameEl = el.querySelector('.modal-title, h2, h3, .customer-name, [data-customer-name]');
          if (nameEl) {
            const name = nameEl.textContent.replace(/Customer Details?/i, '').replace(/[*_`#]/g, '').trim();
            if (name.length > 1) sessionCtx.customer = name;
          }
        }

        // Vehicle edit / add: scrape vehicle name for context
        if (id === 'edit-vehicle-modal' || id === 'add-vehicle-modal') {
          const nameEl = el.querySelector('#ev-name, #av-name, [id$="-name"]');
          if (nameEl && nameEl.value) sessionCtx.vehicle = nameEl.value.trim();
        }
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    };

    // Observe all modals currently in the DOM
    document.querySelectorAll('.modal-overlay[id]').forEach(observeModal);

    // ── 2. Watch for future modals added dynamically ───────────────────────────
    // A lightweight top-level observer that only looks at direct children of body
    // being added — catches any modals injected after page load.
    new MutationObserver((mutations) => {
      for (const mut of mutations) {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('modal-overlay') && node.id) {
            observeModal(node);
          }
          // Also catch modals nested inside added containers
          node.querySelectorAll && node.querySelectorAll('.modal-overlay[id]').forEach(observeModal);
        });
      }
    }).observe(document.body, { childList: true, subtree: false });

    // ── 3. Watch #page-title for navigation changes ────────────────────────────
    // Any time the admin navigates to a new section, #page-title text updates.
    // We store it so getCurrentSection() always has a live fallback, and the
    // AI knows which area of the dashboard the admin is working in right now.
    const titleEl = document.getElementById('page-title');
    if (titleEl) {
      new MutationObserver(() => {
        // currentPage global is updated by navigate() — getCurrentSection() reads it live.
        // Watching page-title ensures we catch any programmatic navigation too.
        const title = titleEl.textContent.trim();
        if (title) sessionCtx.section = title;
      }).observe(titleEl, { characterData: true, childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
