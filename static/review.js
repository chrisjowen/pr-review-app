// The shared review tab (pr-review-wheelhouse's wheelhouse/ui), hosted by this site instead of
// Wheelhouse: its "engine" is this site's /engine API, for the signed-in user.
import '/ui/index.js';

const slot = document.getElementById('tab');
const pr = slot.dataset.pr;
const url = new URL(window.location.href);
if (url.searchParams.get('pr') !== pr) {
	url.searchParams.set('pr', pr);
	history.replaceState(null, '', url);
}
const el = document.createElement('pr-review-tab');
el.host = {
	service: async () => ({ state: 'running', url: `${window.location.origin}/engine` }),
	launch: async () => {},
	features: { post: false, firstmate: false, markdown: true, autoOpen: true }
};
el.entry = { projectId: 'web' };
el.data = { project: 'web', prs: [], settings: JSON.parse(slot.dataset.settings || '{}') };
slot.replaceWith(el);
