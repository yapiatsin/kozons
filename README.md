# Kozons

Messagerie en temps réel + réseau social (inspiré de WhatsApp et Instagram), en Django + Channels
avec une interface web monopage en JavaScript pur (sans étape de build).

## Démarrer

```bash
env\Scripts\python.exe -m pip install -r requirements.txt
env\Scripts\python.exe manage.py migrate
env\Scripts\python.exe manage.py runserver 127.0.0.1:8010
```

Ouvrez http://127.0.0.1:8010 et créez un compte (ou utilisez les comptes de démo `alice`, `bob`,
`carol` — mot de passe `kozons123` — s'ils existent dans votre base).

Tests : `env\Scripts\python.exe manage.py test`

## Fonctionnalités

**Messagerie (WhatsApp)**
- Discussions privées et groupes (jusqu'à 1024 membres), admins, ajout/retrait, sortie de groupe
- Temps réel par WebSocket : nouveaux messages, « écrit… » / « enregistre un audio… », en ligne / vu à
- Accusés ✓ envoyé, ✓✓ distribué, ✓✓ bleu lu (désactivables), infos du message (qui a lu)
- Texte enrichi (*gras*, _italique_, ~barré~, `code`, liens), emojis, grands emojis
- Photos, vidéos, documents, audio, messages vocaux (pause, vitesse 1×/1,5×/2×), position, contact, sondages
- Médias à vue unique, messages éphémères (24 h / 7 j / 90 j)
- Répondre (citation), transférer, modifier (15 min), supprimer pour moi / pour tous, réactions, messages importants
- Épingler, archiver, sourdine, marquer non lu, vider la discussion, recherche dans les messages
- Glisser-déposer et coller des fichiers, envoi optimiste avec progression et « Réessayer » en cas d'échec
- Blocage de contacts, confidentialité (vu à, photo de profil, confirmations de lecture)
- Appels audio et vidéo 1-à-1 (WebRTC) : sonnerie, micro/caméra, changer de caméra, partage d'écran,
  passage audio → vidéo, historique des appels (manqués, entrants, sortants)

**Social (Instagram)**
- Fil d'actualité, publications multi-photos/vidéos (carrousel), double-tap pour aimer
- Commentaires avec réponses et J'aime, mentions @ et #hashtags, enregistrements, archives
- Reels (défilement vertical, lecture auto), Explorer avec recherche
- Profils, abonnés/abonnements, comptes privés avec demandes d'abonnement, suggestions
- Stories / Statuts 24 h (photo, vidéo, texte coloré), amis proches, vues, J'aime, réponses en message privé
- Notifications en temps réel, partage de publications en discussion

**Robustesse**
- Reconnexion WebSocket automatique avec backoff + rattrapage des messages manqués
- Pagination par curseur, requêtes groupées (liste des discussions en nombre constant de requêtes)
- Limitation de débit (connexion, inscription, envois), contrôle d'accès sur chaque ressource
- Fichiers dangereux refusés (html, svg, js, exe…), CSRF, sessions, SQLite en mode WAL
- Thème clair/sombre, responsive mobile, installable (PWA), notifications du navigateur

## Architecture

| Dossier | Rôle |
|---|---|
| `accounts/` | Utilisateur personnalisé, blocage, profil, confidentialité |
| `chat/` | Discussions, messages, reçus, appels ; `consumers.py` = WebSocket, `services.py` = logique métier |
| `social/` | Publications, commentaires, abonnements, stories, notifications |
| `kozons/` | Coque de l'application, routes API, fichiers statiques (`static/kozons/js/views/*`) |

## Configuration (.env)

La configuration est lue dans `.env` (modèle : `.env.example`) : `SECRET_KEY`, `DEBUG`,
`ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, les paramètres SMTP (`EMAIL_*`, `DEFAULT_FROM_EMAIL`) et
`PASSWORD_RESET_OTP_MINUTES`. Ne jamais commiter `.env`.

**Mot de passe oublié** : l'utilisateur saisit son e-mail ou son nom d'utilisateur, reçoit un code
à 6 chiffres par e-mail (valable 10 min, 5 essais, 1 envoi par minute), puis choisit un nouveau mot
de passe ; les autres appareils sont déconnectés et un e-mail de confirmation est envoyé.
Les mots de passe exigent 8 caractères, une majuscule, une minuscule et un chiffre.

## Production

- Dans `.env` : `DEBUG=False`, une vraie `SECRET_KEY`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`
- Plusieurs processus : `pip install channels-redis` et `KOZONS_REDIS_URL=redis://…`
- Appels hors réseau local : serveur TURN (`KOZONS_TURN_URL`, `KOZONS_TURN_USER`, `KOZONS_TURN_PASSWORD`)
- HTTPS obligatoire pour micro/caméra hors localhost ; servir `/media/` par nginx ; PostgreSQL recommandé

## Pas encore implémenté

- Chiffrement de bout en bout (protocole Signal) — les messages sont protégés par contrôle d'accès, pas chiffrés côté client
- Appels de groupe, notifications push navigateur fermé (Web Push/VAPID), applications mobiles natives
- Communautés/chaînes WhatsApp, messages programmés, traduction, filtres photo
