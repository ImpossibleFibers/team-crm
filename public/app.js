// The browse page: the people list at /, one person at /people/<id>.
// It only reads, from /api/*. Changes go through Claude.

const app = document.getElementById('app');
const SITE = document.querySelector('.brand')?.textContent || 'CRM';

const RELATIONSHIPS = { collaborating: 'Collaborating', want_to_collaborate: 'Want to collaborate', in_touch: 'In touch' };
const INTERACTION_TYPES = {
  meeting: 'Meeting', call: 'Call', email_sent: 'Email sent', email_received: 'Email received', message: 'Message', event: 'Event',
};
const ACTION_TYPES = { email: 'Email', follow_up: 'Follow-up', meeting: 'Meeting', other: 'Other' };
const ACTION_STATUSES = { suggested: 'Suggested', approved: 'Approved' };
const SORTS = { name: 'Name', recent: 'Last contacted, newest', oldest: 'Last contacted, oldest' };

// h('a', { href: '/x', class: 'y' }, 'text', child, [more]) builds an element.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));
  return el;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Signed out.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The CRM answered ${res.status}.`);
  return body;
}

function formatDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (y !== new Date().getFullYear()) options.year = 'numeric';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', options);
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

function showError(err) {
  app.replaceChildren(h('p', { class: 'empty' }, err.message));
}

function route() {
  const match = /^\/people\/([^/]+)\/?$/.exec(location.pathname);
  if (match) showPerson(decodeURIComponent(match[1])).catch(showError);
  else showList().catch(showError);
}

// ---------------------------------------------------------------- the people list

let filterChoices = null;
let listView = null; // kept so coming back to the list keeps its scroll position
let listScroll = 0;
let listSearch = '';

function readState() {
  const p = new URLSearchParams(location.search);
  return {
    q: p.get('q') || '',
    tags: p.getAll('tag'),
    relationship: p.get('relationship') || '',
    organization: p.get('organization') || '',
    owner: p.get('owner') || '',
    stale: p.get('stale') || '',
    never: p.get('never') === '1',
    sort: SORTS[p.get('sort')] ? p.get('sort') : 'name',
  };
}

function stateParams(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  for (const t of s.tags) p.append('tag', t);
  for (const k of ['relationship', 'organization', 'owner', 'stale']) if (s[k]) p.set(k, s[k]);
  if (s.never) p.set('never', '1');
  if (s.sort !== 'name') p.set('sort', s.sort);
  return p;
}

const activeFilters = (s) =>
  s.tags.length + ['relationship', 'organization', 'owner', 'stale'].filter((k) => s[k]).length + (s.never ? 1 : 0);

function lastContacted(lc) {
  if (!lc) return h('span', { class: 'muted' }, 'Never');
  return [formatDate(lc.date), h('span', { class: 'type' }, INTERACTION_TYPES[lc.type] || lc.type)];
}

function tagChip(tag, onToggle) {
  if (!tag.useful_for) return h('span', { class: 'tag' }, tag.tag);
  const chip = h('button', { type: 'button', class: 'tag', 'data-note': tag.useful_for, 'aria-expanded': 'false' }, tag.tag);
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle(chip, tag);
  });
  return chip;
}

function personRow(p) {
  const note = h('div', { class: 'c-note', hidden: true });
  let open = null;
  const toggle = (chip, tag) => {
    if (open) open.setAttribute('aria-expanded', 'false');
    if (open === chip) {
      open = null;
      note.hidden = true;
      return;
    }
    open = chip;
    chip.setAttribute('aria-expanded', 'true');
    note.replaceChildren(h('strong', {}, tag.tag), ' ', tag.useful_for);
    note.hidden = false;
  };
  return h(
    'div',
    {
      class: 'row',
      onclick: (e) => {
        if (!e.target.closest('a, button')) navigate(`/people/${p.id}`);
      },
    },
    h('div', { class: 'c-name' }, h('a', { href: `/people/${p.id}`, 'data-nav': true }, p.name)),
    h('div', { class: 'c-org' }, p.organization || ''),
    h('div', { class: 'c-tags' }, p.tags.map((t) => tagChip(t, toggle))),
    note,
    h('div', { class: 'c-rel' }, RELATIONSHIPS[p.relationship] || p.relationship),
    h('div', { class: 'c-owner' }, p.owner || ''),
    h('div', { class: 'c-last' }, lastContacted(p.last_contacted)),
  );
}

function options(select, choices, current) {
  select.replaceChildren(...choices.map(([value, label]) => h('option', { value, selected: value === current }, label)));
  return select;
}

async function showList() {
  document.title = SITE;
  if (listView && listSearch === location.search) {
    app.replaceChildren(listView);
    window.scrollTo(0, listScroll);
    return;
  }
  const state = readState();
  const [choices] = await Promise.all([filterChoices || getJson('/api/filters')]);
  filterChoices = choices;

  const count = h('p', { class: 'count' });
  const list = h('div', { class: 'people' });
  const more = h('button', { type: 'button', class: 'toggle more', hidden: true }, 'Show more');
  let loaded = 0;
  let requestNumber = 0;

  async function load(append = false) {
    const mine = ++requestNumber;
    const params = stateParams(state);
    if (append) params.set('offset', String(loaded));
    let result;
    try {
      result = await getJson(`/api/people?${params}`);
    } catch (err) {
      if (mine !== requestNumber) return;
      count.textContent = err.message;
      list.replaceChildren();
      more.hidden = true;
      return;
    }
    if (mine !== requestNumber) return;
    if (!append) {
      loaded = 0;
      list.replaceChildren(head());
    }
    list.append(...result.people.map(personRow));
    loaded += result.people.length;
    count.textContent = result.total === 1 ? '1 person' : `${result.total} people`;
    if (!result.total) list.replaceChildren(h('p', { class: 'empty' }, 'No one matches.'));
    more.hidden = loaded >= result.total;
  }

  const head = () =>
    h('div', { class: 'row head' },
      h('div', { class: 'c-name' }, 'Name'), h('div', { class: 'c-org' }, 'Organization'), h('div', { class: 'c-tags' }, 'Tags'),
      h('div', { class: 'c-rel' }, 'Relationship'), h('div', { class: 'c-owner' }, 'Owner'), h('div', { class: 'c-last' }, 'Last contacted'));

  function changed() {
    const qs = stateParams(state).toString();
    history.replaceState(null, '', qs ? `/?${qs}` : '/');
    listSearch = location.search;
    toggle.textContent = activeFilters(state) ? `Filters (${activeFilters(state)})` : 'Filters';
    load();
  }

  // Search and sort
  let typing;
  const search = h('input', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people', value: state.q });
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.q = search.value.trim();
      changed();
    }, 200);
  });
  const sort = options(h('select', { 'aria-label': 'Sort' }), Object.entries(SORTS), state.sort);
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    changed();
  });

  // Filters
  const filters = h('div', { class: 'filters', id: 'filters', hidden: !activeFilters(state) });
  const toggle = h('button', { type: 'button', class: 'toggle', 'aria-controls': 'filters', 'aria-expanded': String(!filters.hidden) });
  toggle.addEventListener('click', () => {
    filters.hidden = !filters.hidden;
    toggle.setAttribute('aria-expanded', String(!filters.hidden));
  });

  const chosen = h('div', { class: 'chosen' });
  const renderChosen = () =>
    chosen.replaceChildren(
      ...state.tags.map((t) =>
        h('button', {
          type: 'button',
          class: 'chip-remove',
          'aria-label': `Remove the ${t} filter`,
          onclick: () => {
            state.tags = state.tags.filter((x) => x !== t);
            renderChosen();
            changed();
          },
        }, t, h('span', { 'aria-hidden': 'true' }, '×')),
      ),
    );
  const tagSelect = options(h('select'), [['', 'Add a tag…'], ...choices.tags.map((t) => [t.name, `${t.name} (${t.people})`])], '');
  tagSelect.addEventListener('change', () => {
    if (tagSelect.value && !state.tags.includes(tagSelect.value)) state.tags.push(tagSelect.value);
    tagSelect.value = '';
    renderChosen();
    changed();
  });
  const select = (key, choicesList) => {
    const el = options(h('select'), choicesList, state[key]);
    el.addEventListener('change', () => {
      state[key] = el.value;
      changed();
    });
    return el;
  };
  const stale = h('input', { type: 'number', min: '1', inputmode: 'numeric', value: state.stale, 'aria-label': 'Days' });
  stale.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.stale = /^[1-9]\d*$/.test(stale.value) ? stale.value : '';
      changed();
    }, 300);
  });
  const never = h('input', { type: 'checkbox', checked: state.never });
  never.addEventListener('change', () => {
    state.never = never.checked;
    changed();
  });
  const clear = h('button', { type: 'button', class: 'link' }, 'Clear filters');
  clear.addEventListener('click', () => {
    Object.assign(state, { tags: [], relationship: '', organization: '', owner: '', stale: '', never: false });
    for (const el of filters.querySelectorAll('select')) el.value = '';
    stale.value = '';
    never.checked = false;
    renderChosen();
    changed();
  });

  filters.append(
    h('label', {}, 'Tags (all must match)', tagSelect),
    h('label', {}, 'Relationship', select('relationship', [['', 'Any'], ...Object.entries(RELATIONSHIPS)])),
    h('label', {}, 'Organization', select('organization', [['', 'Any'], ...choices.organizations.map((o) => [o.id, o.name])])),
    h('label', {}, 'Owner', select('owner', [['', 'Anyone'], ...choices.teammates.map((t) => [t.email, t.name])])),
    h('label', { class: 'inline' }, 'Not contacted in', stale, 'days'),
    h('label', { class: 'check' }, never, 'Never contacted'),
    h('div', { class: 'end' }, clear),
    chosen,
  );
  renderChosen();
  toggle.textContent = activeFilters(state) ? `Filters (${activeFilters(state)})` : 'Filters';

  listView = h('div', {},
    h('h1', {}, 'People'),
    h('div', { class: 'controls' }, search, toggle, sort),
    filters,
    count,
    list,
    more,
  );
  more.addEventListener('click', () => load(true));
  listSearch = location.search;
  listScroll = 0;
  app.replaceChildren(listView);
  await load();
}

// ---------------------------------------------------------------- one person

function section(title, items, render, emptyText) {
  return [
    h('h2', {}, title),
    items.length ? render(items) : h('p', { class: 'empty' }, emptyText),
  ];
}

async function showPerson(id) {
  if (app.firstChild === listView) listScroll = window.scrollY;
  app.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  window.scrollTo(0, 0);
  const p = await getJson(`/api/people/${encodeURIComponent(id)}`);
  document.title = `${p.name} · ${SITE}`;

  const subtitle = [p.role, p.organization].filter(Boolean).join(', ');
  const lc = p.last_contacted;
  const facts = [
    ['Email', p.email && h('a', { href: `mailto:${p.email}` }, p.email)],
    ['Relationship', RELATIONSHIPS[p.relationship] || p.relationship],
    ['Owner', p.owner],
    ['Last contacted', lc && `${formatDate(lc.date)}, ${(INTERACTION_TYPES[lc.type] || lc.type).toLowerCase()}${lc.logged_by ? ` (logged by ${lc.logged_by})` : ''}`],
    ['How we met', p.how_we_met],
    ['Added', [p.added.by, formatDate(p.added.on)].filter(Boolean).join(', ')],
    ['Last updated', [p.last_updated.by, formatDate(p.last_updated.on)].filter(Boolean).join(', ')],
  ].filter(([, v]) => v);

  const others = (i) => i.people.filter((x) => x.id !== p.id).map((x) => x.name);

  app.replaceChildren(h('article', {},
    h('a', { class: 'back', href: listSearch ? `/${listSearch}` : '/', 'data-nav': true }, '← People'),
    h('h1', {}, p.name),
    subtitle && h('p', { class: 'subtitle' }, subtitle),
    h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    section('Tags', p.tags, (tags) =>
      h('ul', { class: 'tags-list' }, tags.map((t) => h('li', {}, h('span', { class: 'tag' }, t.tag), h('span', {}, t.useful_for)))),
    'No tags.'),
    p.notes ? [h('h2', {}, 'Notes'), h('p', { class: 'notes' }, p.notes)] : null,
    section('Follow-ups', p.actions, (actions) =>
      h('ul', { class: 'actions' }, actions.map((a) =>
        h('li', {},
          h('p', { class: 'title' }, a.title),
          h('p', { class: 'meta' }, [
            ACTION_STATUSES[a.status] || a.status,
            ACTION_TYPES[a.type] || a.type,
            a.due_date && `due ${formatDate(a.due_date)}`,
            a.assigned_to && `for ${a.assigned_to}`,
          ].filter(Boolean).join(' · ')),
          (a.draft_subject || a.draft_body) && h('div', { class: 'draft' },
            a.draft_subject && h('p', { class: 'draft-subject' }, a.draft_subject),
            a.draft_body && h('p', { class: 'draft-body' }, a.draft_body)),
          a.notes && h('p', { class: 'details' }, a.notes),
        ))),
    'No open follow-ups.'),
    section('History', p.interactions, (interactions) =>
      h('ul', { class: 'events' }, interactions.map((i) =>
        h('li', {},
          h('div', { class: 'when' }, formatDate(i.date)),
          h('div', {},
            h('p', {}, h('span', { class: 'type' }, INTERACTION_TYPES[i.type] || i.type), i.summary),
            i.details && h('p', { class: 'details' }, i.details),
            h('p', { class: 'by' }, [
              others(i).length && `With ${others(i).join(', ')}`,
              i.logged_by && `Logged by ${i.logged_by}`,
            ].filter(Boolean).join(' · ')),
          ),
        ))),
    'Nothing logged yet.'),
  ));
}

route();
