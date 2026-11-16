import { FaultInjector, InjectedFaultError } from './fault-injector';

describe('FaultInjector', () => {
  it('is inert by default outside tests: arming does nothing', () => {
    const faults = new FaultInjector({ NODE_ENV: 'production' });
    expect(faults.enabled).toBe(false);
    faults.arm('search_listings');
    expect(() => faults.check('search_listings')).not.toThrow();
  });

  it('ignores ASSISTANT_FAULT_TOOLS when not enabled', () => {
    const faults = new FaultInjector({ NODE_ENV: 'development', ASSISTANT_FAULT_TOOLS: 'search_listings' });
    expect(() => faults.check('search_listings')).not.toThrow();
  });

  it('is enabled under NODE_ENV=test and makes only the armed tool throw', () => {
    const faults = new FaultInjector({ NODE_ENV: 'test' });
    faults.arm('search_listings');
    expect(() => faults.check('search_listings')).toThrow(InjectedFaultError);
    expect(() => faults.check('get_lead_tasks')).not.toThrow();
    faults.disarm();
    expect(() => faults.check('search_listings')).not.toThrow();
  });

  it('is enabled by ASSISTANT_FAULTS_ENABLED=1 and reads ASSISTANT_FAULT_TOOLS', () => {
    const faults = new FaultInjector({ NODE_ENV: 'production', ASSISTANT_FAULTS_ENABLED: '1', ASSISTANT_FAULT_TOOLS: ' get_listing_details , search_listings' });
    expect(faults.enabled).toBe(true);
    expect(() => faults.check('search_listings')).toThrow('Injected fault: search_listings is unavailable.');
    expect(() => faults.check('get_listing_details')).toThrow(InjectedFaultError);
    expect(() => faults.check('get_lead_tasks')).not.toThrow();
  });

  it('only accepts ASSISTANT_FAULTS_ENABLED=1 exactly', () => {
    expect(new FaultInjector({ ASSISTANT_FAULTS_ENABLED: 'true' }).enabled).toBe(false);
    expect(new FaultInjector({}).enabled).toBe(false);
  });
});
