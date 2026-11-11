import { useModal } from '../hooks/useModal.ts';
import { useI18n } from '../i18n/index.tsx';
import { CheckIcon, LockIcon, ShieldIcon, SparkIcon, XIcon } from './Icons.tsx';

export function PrivacyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const modal = useModal<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={modal.ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('modal.title')}
        tabIndex={-1}
        onKeyDown={modal.onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t('modal.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('actions.close')}
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-lead">
            <SparkIcon size={18} />
            <span>{t('modal.intro')}</span>
          </p>

          <section className="modal-section">
            <h3>
              <LockIcon size={16} />
              {t('modal.verifyTitle')}
            </h3>
            <p>{t('modal.verifyBody')}</p>
          </section>

          <div className="modal-grid">
            <section className="modal-section">
              <h3>
                <CheckIcon size={16} />
                {t('modal.removedTitle')}
              </h3>
              <p>{t('modal.removedBody')}</p>
            </section>
            <section className="modal-section">
              <h3>
                <ShieldIcon size={16} />
                {t('modal.keptTitle')}
              </h3>
              <p>{t('modal.keptBody')}</p>
            </section>
          </div>

          <section className="modal-section">
            <h3>
              <ShieldIcon size={16} />
              {t('modal.c2paTitle')}
            </h3>
            <p>{t('modal.c2paBody')}</p>
          </section>

          <section className="modal-section modal-section--muted">
            <h3>
              <XIcon size={16} />
              {t('modal.limitsTitle')}
            </h3>
            <p>{t('modal.limitsBody')}</p>
          </section>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t('modal.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
