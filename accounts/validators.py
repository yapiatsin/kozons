import re

from django.core.exceptions import ValidationError


class CharacterClassesValidator:
    """Exige au moins une majuscule, une minuscule et un chiffre."""

    RULES = (
        (re.compile(r'[A-Z]'), 'une lettre majuscule'),
        (re.compile(r'[a-z]'), 'une lettre minuscule'),
        (re.compile(r'\d'), 'un chiffre'),
    )

    def validate(self, password, user=None):
        missing = [label for pattern, label in self.RULES if not pattern.search(password or '')]
        if missing:
            raise ValidationError(
                'Le mot de passe doit contenir au moins ' + ', '.join(missing) + '.',
                code='password_character_classes',
            )

    def get_help_text(self):
        return 'Votre mot de passe doit contenir au moins une majuscule, une minuscule et un chiffre.'
