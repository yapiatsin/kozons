// Écrans de connexion, d'inscription et de mot de passe oublié (code OTP par e-mail).
import { api } from '../api.js';
import { h, clear, icon } from '../ui.js';

// Mêmes règles que le serveur (accounts/validators.py + longueur minimale).
export const PASSWORD_RULES = [
  [p => p.length >= 8, '8 caractères minimum'],
  [p => /[A-Z]/.test(p), 'Une majuscule'],
  [p => /[a-z]/.test(p), 'Une minuscule'],
  [p => /\d/.test(p), 'Un chiffre'],
];

export const passwordIsValid = p => PASSWORD_RULES.every(([test]) => test(p));

/** Champ mot de passe avec bouton œil pour afficher / masquer. */
export function passwordInput({ name = 'password', placeholder = 'Mot de passe', autocomplete = 'current-password' } = {}) {
  const input = h('input.input', { name, type: 'password', placeholder, autocomplete, required: true });
  const eye = h('button.pw-toggle', {
    type: 'button', 'aria-label': 'Afficher le mot de passe', title: 'Afficher le mot de passe',
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 20));
      const label = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
      eye.setAttribute('aria-label', label);
      eye.title = label;
      input.focus();
    },
  }, icon('eye', 20));
  return { input, el: h('div.pw-field', input, eye) };
}

/** Liste des règles, cochées au fur et à mesure de la saisie. */
export function passwordChecklist(input) {
  const items = PASSWORD_RULES.map(([test, label]) => ({ test, el: h('li', h('span.rule-dot'), label) }));
  const list = h('ul.pw-rules', { 'aria-live': 'polite' }, items.map(i => i.el));
  const update = () => items.forEach(({ test, el }) => el.classList.toggle('ok', test(input.value)));
  input.addEventListener('input', update);
  update();
  return list;
}

/** Saisie d'un code à 6 chiffres (collage accepté, passage automatique à la case suivante). */
function otpInput(onComplete) {
  const boxes = Array.from({ length: 6 }, (_, i) => h('input.otp-box', {
    type: 'text', inputmode: 'numeric', autocomplete: i === 0 ? 'one-time-code' : 'off',
    'aria-label': `Chiffre ${i + 1} du code`,
  }));
  const value = () => boxes.map(b => b.value).join('');
  const fill = (digits, from = 0) => {
    digits.split('').slice(0, 6 - from).forEach((d, j) => { boxes[from + j].value = d; });
    const next = boxes.find(b => !b.value);
    (next || boxes[5]).focus();
    if (value().length === 6) onComplete(value());
  };
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const digits = box.value.replace(/\D/g, '');
      box.value = '';
      if (digits) fill(digits, i);
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      else if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      fill((e.clipboardData.getData('text') || '').replace(/\D/g, ''), i);
    });
    box.addEventListener('focus', () => box.select());
  });
  return {
    el: h('div.otp', boxes),
    value,
    clear: () => { boxes.forEach(b => { b.value = ''; }); boxes[0].focus(); },
    focus: () => boxes[0].focus(),
  };
}

function link(label, onclick) {
  return h('a', { href: '#', onclick: e => { e.preventDefault(); onclick(); } }, label);
}

function busy(button, fn) {
  return async (...args) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Patientez…';
    try { await fn(...args); } finally { button.disabled = false; button.textContent = label; }
  };
}

// ------------------------------------------------------------------ écrans

export function renderAuth(root, onDone) {
  const card = h('div.auth-card');
  const tagline = () => h('p.auth-tagline', 'Discutez, appelez, partagez vos moments. Messagerie en temps réel, appels vidéo, stories, publications et reels — au même endroit.');
  const finish = (user, path) => {
    history.replaceState({}, '', path || location.pathname);
    onDone(user);
  };

  function showLogin(prefill = '', notice = '') {
    const error = h('div.auth-error');
    const username = h('input.input', { name: 'username', placeholder: "Nom d'utilisateur ou e-mail", autocomplete: 'username', required: true, autocapitalize: 'none', value: prefill });
    const pw = passwordInput();
    const submit = h('button.btn.primary.block', { type: 'submit' }, 'Se connecter');
    const form = h('form.auth-form', {
      onsubmit: e => {
        e.preventDefault();
        busy(submit, async () => {
          error.textContent = '';
          try {
            const res = await api.post('auth/login', { username: username.value.trim(), password: pw.input.value });
            if (res.otp_required) showLoginCode(res, username.value.trim());
            else finish(res.user);
          } catch (err) { error.textContent = err.message; }
        })();
      },
    }, username, pw.el,
    h('div.auth-forgot', link('Mot de passe oublié ?', () => showForgot(username.value.trim()))),
    error, submit);
    clear(card,
      h('h2', 'Bienvenue'),
      tagline(),
      notice ? h('div.auth-notice', notice) : null,
      form,
      h('p.auth-switch', "Vous n'avez pas de compte ? ", link('Inscrivez-vous', showRegister)));
    (prefill ? pw.input : username).focus();
  }

  // Étape 2 de la connexion : code à 6 chiffres reçu par e-mail.
  function showLoginCode(res, identifier) {
    let challenge = res.challenge;
    let cooldownTimer = null;
    const stop = () => clearInterval(cooldownTimer);
    const error = h('div.auth-error');
    const notice = h('div.auth-notice', icon('lock', 16), ` Code envoyé à ${res.email_hint}`);
    const submit = h('button.btn.primary.block', { type: 'submit' }, 'Valider et se connecter');
    const verify = busy(submit, async () => {
      const code = otp.value();
      if (code.length !== 6) { error.textContent = 'Saisissez les 6 chiffres du code.'; return; }
      error.textContent = '';
      try {
        const { user } = await api.post('auth/login/verify', { challenge, code });
        stop();
        finish(user, '/');
      } catch (err) {
        error.textContent = err.message;
        otp.clear();
        if (/session de connexion/.test(err.message)) { // défi expiré : retour au formulaire
          stop();
          showLogin(identifier, err.message);
        }
      }
    });
    const otp = otpInput(() => verify());
    const resend = h('button.link.resend', { type: 'button' });
    const startCooldown = seconds => {
      stop();
      let left = seconds;
      const tick = () => {
        resend.disabled = left > 0;
        resend.textContent = left > 0 ? `Renvoyer le code (${left} s)` : 'Renvoyer le code';
        if (left-- <= 0) stop();
      };
      tick();
      cooldownTimer = setInterval(tick, 1000);
    };
    resend.onclick = async () => {
      resend.disabled = true;
      try {
        const r = await api.post('auth/login/resend', { challenge });
        challenge = r.challenge;
        error.textContent = '';
        notice.lastChild.textContent = ` Nouveau code envoyé à ${r.email_hint}`;
        otp.clear();
        startCooldown(r.resend_after_seconds);
      } catch (err) { error.textContent = err.message; resend.disabled = false; }
    };
    clear(card,
      h('h2', 'Vérification'),
      notice,
      h('p.auth-lead', `Saisissez le code à 6 chiffres reçu par e-mail. Il expire dans ${res.expires_in_minutes} minutes. Pensez à vérifier vos courriers indésirables.`),
      h('form.auth-form', { onsubmit: e => { e.preventDefault(); verify(); } },
        otp.el, error, submit,
        h('div.auth-row', resend, link('Changer de compte', () => { stop(); showLogin(identifier); }))));
    startCooldown(res.resend_after_seconds);
    otp.focus();
  }

  function showRegister() {
    const error = h('div.auth-error');
    const username = h('input.input', { name: 'username', placeholder: "Nom d'utilisateur", autocomplete: 'username', required: true, autocapitalize: 'none', minlength: 3, maxlength: 30 });
    const email = h('input.input', { name: 'email', type: 'email', placeholder: 'Adresse e-mail', autocomplete: 'email', required: true });
    const displayName = h('input.input', { name: 'display_name', placeholder: 'Nom complet (facultatif)', autocomplete: 'name' });
    const pw = passwordInput({ placeholder: 'Mot de passe', autocomplete: 'new-password' });
    const submit = h('button.btn.primary.block', { type: 'submit' }, "S'inscrire");
    const form = h('form.auth-form', {
      onsubmit: e => {
        e.preventDefault();
        if (!passwordIsValid(pw.input.value)) { error.textContent = 'Le mot de passe ne respecte pas toutes les règles.'; return; }
        busy(submit, async () => {
          error.textContent = '';
          try {
            const { user } = await api.post('auth/register', {
              username: username.value.trim(), email: email.value.trim(),
              display_name: displayName.value.trim(), password: pw.input.value,
            });
            finish(user, '/settings');
          } catch (err) { error.textContent = err.message; }
        })();
      },
    }, username, email, displayName, pw.el, passwordChecklist(pw.input), error, submit);
    clear(card,
      h('h2', 'Créer un compte'),
      form,
      h('p.auth-switch', 'Vous avez un compte ? ', link('Connectez-vous', () => showLogin())));
    username.focus();
  }

  function showForgot(prefill = '') {
    let identifier = prefill;
    let resetToken = null;
    let cooldownTimer = null;
    const stepEl = h('div');
    const stop = () => clearInterval(cooldownTimer);
    const back = link('Retour à la connexion', () => { stop(); showLogin(identifier.includes('@') ? '' : identifier); });

    // Étape 1 : adresse e-mail ou nom d'utilisateur.
    const stepIdentifier = () => {
      const error = h('div.auth-error');
      const input = h('input.input', { placeholder: "Adresse e-mail ou nom d'utilisateur", autocomplete: 'username', required: true, autocapitalize: 'none', value: identifier });
      const submit = h('button.btn.primary.block', { type: 'submit' }, 'Recevoir un code');
      clear(stepEl,
        h('p.auth-lead', 'Saisissez l\'adresse e-mail ou le nom d\'utilisateur de votre compte. Nous vous enverrons un code de vérification à 6 chiffres.'),
        h('form.auth-form', {
          onsubmit: e => {
            e.preventDefault();
            busy(submit, async () => {
              error.textContent = '';
              try {
                identifier = input.value.trim();
                const res = await api.post('auth/password/forgot', { identifier });
                stepCode(res);
              } catch (err) { error.textContent = err.message; }
            })();
          },
        }, input, error, submit));
      input.focus();
    };

    // Étape 2 : code reçu par e-mail.
    const stepCode = res => {
      const error = h('div.auth-error');
      const submit = h('button.btn.primary.block', { type: 'submit' }, 'Vérifier le code');
      const verify = busy(submit, async () => {
        const code = otp.value();
        if (code.length !== 6) { error.textContent = 'Saisissez les 6 chiffres du code.'; return; }
        error.textContent = '';
        try {
          ({ reset_token: resetToken } = await api.post('auth/password/verify', { identifier, code }));
          stop();
          stepPassword();
        } catch (err) { error.textContent = err.message; otp.clear(); }
      });
      const otp = otpInput(() => verify());
      const resend = h('button.link.resend', { type: 'button' });
      const startCooldown = seconds => {
        stop();
        let left = seconds;
        const tick = () => {
          resend.disabled = left > 0;
          resend.textContent = left > 0 ? `Renvoyer le code (${left} s)` : 'Renvoyer le code';
          if (left-- <= 0) stop();
        };
        tick();
        cooldownTimer = setInterval(tick, 1000);
      };
      resend.onclick = async () => {
        try {
          const r = await api.post('auth/password/forgot', { identifier });
          error.textContent = '';
          notice.textContent = 'Un nouveau code a été envoyé si un compte correspond.';
          otp.clear();
          startCooldown(r.resend_after_seconds);
        } catch (err) { error.textContent = err.message; }
      };
      const notice = h('div.auth-notice', res.message);
      clear(stepEl,
        notice,
        h('p.auth-lead', `Saisissez le code reçu. Il expire dans ${res.expires_in_minutes} minutes. Pensez à vérifier vos courriers indésirables.`),
        h('form.auth-form', { onsubmit: e => { e.preventDefault(); verify(); } },
          otp.el, error, submit,
          h('div.auth-row', resend, link('Changer d\'adresse', () => { stop(); stepIdentifier(); }))));
      startCooldown(res.resend_after_seconds);
      otp.focus();
    };

    // Étape 3 : nouveau mot de passe.
    const stepPassword = () => {
      const error = h('div.auth-error');
      const pw = passwordInput({ name: 'new_password', placeholder: 'Nouveau mot de passe', autocomplete: 'new-password' });
      const confirm = passwordInput({ name: 'confirm_password', placeholder: 'Confirmer le mot de passe', autocomplete: 'new-password' });
      const submit = h('button.btn.primary.block', { type: 'submit' }, 'Enregistrer et se connecter');
      clear(stepEl,
        h('div.auth-notice.success', icon('check', 16), ' Code vérifié. Choisissez votre nouveau mot de passe.'),
        h('form.auth-form', {
          onsubmit: e => {
            e.preventDefault();
            if (!passwordIsValid(pw.input.value)) { error.textContent = 'Le mot de passe ne respecte pas toutes les règles.'; return; }
            if (pw.input.value !== confirm.input.value) { error.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
            busy(submit, async () => {
              error.textContent = '';
              try {
                const { user } = await api.post('auth/password/reset', { reset_token: resetToken, new_password: pw.input.value });
                finish(user, '/');
              } catch (err) { error.textContent = err.message; }
            })();
          },
        }, pw.el, passwordChecklist(pw.input), confirm.el, error, submit));
      pw.input.focus();
    };

    clear(card, h('h2', 'Mot de passe oublié'), stepEl, h('p.auth-switch', back));
    stepIdentifier();
  }

  clear(root, h('div.auth',
    h('div.auth-hero',
      h('img.auth-logo', { src: '/static/kozons/icon.svg', alt: '' }),
      h('h1', 'Kozons'),
      h('ul.auth-features',
        h('li', '💬 Discussions privées et groupes jusqu\'à 1024 membres'),
        h('li', '📞 Appels audio et vidéo'),
        h('li', '⭕ Statuts et stories 24 h'),
        h('li', '📸 Publications, reels et découverte'))),
    card));
  showLogin();
}
