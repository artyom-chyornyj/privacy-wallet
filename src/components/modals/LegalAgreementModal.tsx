import { useState } from 'react'
import './shared-modal.css'
import './LegalAgreementModal.css'

interface LegalAgreementModalProps {
  onAccept: () => void
}

/**
 * Full-screen modal presenting the legal agreement that must be accepted before using the wallet.
 * @param root0 - The component props
 * @param root0.onAccept - Callback invoked when the user accepts all terms
 * @returns The legal agreement modal component
 */
export function LegalAgreementModal ({ onAccept }: LegalAgreementModalProps) {
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false)
  const [checkboxes, setCheckboxes] = useState({
    termsAccepted: false,
    networkDisclosure: false,
    sanctionsCompliance: false,
    ppoiEnforcement: false,
    licenseRestrictions: false,
    conductRestrictions: false,
    noWarranty: false,
  })

  const allChecked = Object.values(checkboxes).every(Boolean)
  const canAccept = hasScrolledToBottom && allChecked

  /**
   * Detects when the user has scrolled to the bottom of the legal text to enable acceptance.
   * @param e - The scroll event from the legal text container
   */
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget
    const isAtBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 50
    if (isAtBottom) {
      setHasScrolledToBottom(true)
    }
  }

  /**
   * Toggles a specific legal agreement checkbox.
   * @param key - The checkbox key to toggle
   */
  const handleCheckboxChange = (key: keyof typeof checkboxes) => {
    setCheckboxes((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className='legal-modal-overlay'>
      <div className='legal-modal-content'>
        <div className='legal-modal-header'>
          <h1>Terms of Use & Legal Agreement</h1>
          <p className='legal-subtitle'>
            This is a binding legal agreement. Please read carefully.
          </p>
        </div>

        <div className='legal-modal-body' onScroll={handleScroll}>
          <section className='legal-section warning-section'>
            <h2>Testnet Software Notice</h2>
            <p>
              This software is provided for <strong>testnet use only</strong>. No contributor
              provides, endorses, or supports any mainnet builds or deployments. Any use of this
              software on mainnet networks is entirely at the user's own risk and responsibility.
              All contributors expressly disclaim any responsibility for mainnet usage.
            </p>
          </section>

          <section className='legal-section'>
            <h2>1. Non-Custodial Software</h2>
            <p>
              <strong>This is non-custodial, open-source software.</strong> No contributor:
            </p>
            <ul>
              <li>
                Has access to, custody of, or control over your private keys, seed phrases, or funds
              </li>
              <li>Operates any servers that hold or transmit your assets</li>
              <li>Has the ability to recover lost keys or reverse transactions</li>
              <li>Intermediates, facilitates, or processes any transactions on your behalf</li>
              <li>
                Provides anything other than open-source code that you choose to run on your device
              </li>
            </ul>
            <p>
              You alone are responsible for securing your private keys and seed phrases. If you lose
              access to them, your funds are permanently unrecoverable. No one can help you recover
              them.
            </p>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.networkDisclosure}
                onChange={() => handleCheckboxChange('networkDisclosure')}
              />
              <span>
                I understand this is non-custodial open-source software, no contributor has access
                to my funds, and I am solely responsible for my private keys and network privacy
              </span>
            </label>
          </section>

          <section className='legal-section'>
            <h2>2. Disclaimer of Warranties</h2>
            <p>
              This software is provided "as is" and "as available" without warranty of any kind,
              express or implied, including but not limited to the warranties of merchantability,
              fitness for a particular purpose, title, non-infringement, and freedom from computer
              virus or other harmful code.
            </p>
            <p>
              No contributor warrants that the software will be uninterrupted, timely, secure, or
              error-free, or that defects will be corrected. No advice or information, whether oral
              or written, obtained through the software will create any warranty not expressly
              stated herein.
            </p>
            <p>You acknowledge and accept that:</p>
            <ul>
              <li>
                This is experimental software that may contain bugs, errors, or security
                vulnerabilities
              </li>
              <li>The software may not function as expected under all conditions</li>
              <li>You are using this software entirely at your own risk</li>
              <li>
                No guarantee is made regarding the protection, security, or recoverability of your
                funds or data
              </li>
              <li>
                Blockchain transactions are irreversible and no one can reverse or modify them
              </li>
            </ul>
          </section>

          <section className='legal-section'>
            <h2>3. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by applicable law, in no event shall any contributor,
              copyright holder, or their affiliates be liable for any direct, indirect, incidental,
              special, exemplary, punitive, or consequential damages whatsoever (including, but not
              limited to, procurement of substitute goods or services; loss of use, data, profits,
              or digital assets; business interruption; personal injury; loss of privacy; security
              breaches; or any other pecuniary loss) however caused and on any theory of liability,
              whether in contract, strict liability, tort (including negligence), or any other legal
              theory, arising out of or in connection with the use or inability to use this
              software, even if advised of the possibility of such damages.
            </p>
            <p>You expressly agree and acknowledge that:</p>
            <ul>
              <li>
                No contributor is responsible for any loss of funds, cryptocurrency, or digital
                assets
              </li>
              <li>
                No contributor is responsible for any unauthorized access to your wallet or keys
              </li>
              <li>
                No contributor is responsible for any actions taken by third parties, hackers, or
                malicious actors
              </li>
              <li>No contributor is responsible for any regulatory actions taken against you</li>
              <li>
                You waive any right to seek damages from any contributor for any reason whatsoever
              </li>
            </ul>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.termsAccepted}
                onChange={() => handleCheckboxChange('termsAccepted')}
              />
              <span>
                I have read, understand, and agree to be bound by the Terms of Use, Disclaimer of
                Warranties, and Limitation of Liability
              </span>
            </label>
          </section>

          <section className='legal-section'>
            <h2>4. Private Proof of Innocence (PPOI) & Sanctions Compliance</h2>
            <p>
              This wallet integrates <strong>PPOI (Private Proof of Innocence)</strong>, a
              cryptographic protocol that enforces sanctions.
            </p>
            <p>
              <strong>PPOI Enforcement</strong>
            </p>
            <ul>
              <li>
                PPOI is designed to help identify and block funds that may originate from
                OFAC-sanctioned, SDNs, and live bad actor sources.
              </li>
              <li>
                All PPOI verification is performed through the official PPOI aggregator node at{' '}
                <strong>ppoi.fdi.network</strong>. This endpoint must not be substituted, replaced,
                or redirected to any other service.
              </li>
              <li>
                Funds linked to the OFAC SDN (Specially Designated Nationals) list are intended to
                be blocked from receiving privacy benefits
              </li>
              <li>
                Transactions that cannot generate a valid proof of innocence are rejected by the
                protocol
              </li>
            </ul>
            <p>
              <strong>Your Representations</strong>
            </p>
            <p>By using this software, you represent and warrant that:</p>
            <ul>
              <li>
                You are not located in, a resident of, or a citizen of Cuba, Iran, North Korea,
                Syria, the Crimea region, or any other jurisdiction subject to U.S. sanctions
              </li>
              <li>
                You are not listed on the OFAC SDN list, the U.S. Commerce Department's Denied
                Persons List, or any similar prohibited parties list
              </li>
              <li>You are not acting on behalf of any person or entity subject to sanctions</li>
              <li>
                You will not use this software to evade sanctions or engage in any prohibited
                transactions
              </li>
              <li>
                You understand that PPOI will block transactions involving sanctioned funds and you
                will lose privacy
              </li>
            </ul>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.sanctionsCompliance}
                onChange={() => handleCheckboxChange('sanctionsCompliance')}
              />
              <span>
                I am not located in a sanctioned jurisdiction, not on any sanctions list, and I
                understand that PPOI cryptographically blocks sanctioned funds from receiving
                privacy
              </span>
            </label>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.ppoiEnforcement}
                onChange={() => handleCheckboxChange('ppoiEnforcement')}
              />
              <span>
                I agree that all funds must be verified through the Privacy Proof of Innocence
                (PPOI) system before they can be spent, and that I cannot use the wallet to interact
                with balances unless they have a valid PPOI status
              </span>
            </label>
          </section>

          <section className='legal-section'>
            <h2>5. Network Connections Disclosure</h2>
            <p>
              <strong>Important:</strong> This wallet makes direct network connections to external
              services. Your IP address may be visible to these services.
            </p>
            <table className='network-table'>
              <thead>
                <tr>
                  <th>Connection Type</th>
                  <th>Purpose</th>
                  <th>Privacy Consideration</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>RPC Nodes</td>
                  <td>Blockchain interaction</td>
                  <td>IP visible to RPC provider</td>
                </tr>
                <tr>
                  <td>Subsquid Indexer</td>
                  <td>Fetching commitment data</td>
                  <td>IP visible to indexer</td>
                </tr>
                <tr>
                  <td>PPOI Aggregator</td>
                  <td>Proof of innocence verification</td>
                  <td>IP visible to aggregator</td>
                </tr>
                <tr>
                  <td>IPFS Gateway</td>
                  <td>Downloading zero-knowledge proof artifacts</td>
                  <td>IP visible to IPFS gateway</td>
                </tr>
                <tr>
                  <td>Blockscout API</td>
                  <td>Public transaction history</td>
                  <td>IP visible to Blockscout</td>
                </tr>
              </tbody>
            </table>
            <p>
              No contributor is responsible for any privacy breaches resulting from network
              connections.
            </p>
          </section>

          <section className='legal-section'>
            <h2>6. User Responsibilities & Legal Compliance</h2>
            <p>By using this software, you represent and warrant that:</p>
            <ul>
              <li>
                You are at least 18 years old or the age of legal majority in your jurisdiction
              </li>
              <li>You have the legal capacity to enter into this binding agreement</li>
              <li>You will only use this software for lawful purposes</li>
              <li>
                You are solely responsible for determining whether your use complies with all
                applicable laws and regulations
              </li>
              <li>
                You will not use this software for money laundering, terrorist financing, tax
                evasion, or any other illegal activity
              </li>
              <li>
                You understand that privacy-preserving technology may be subject to legal
                restrictions in certain jurisdictions
              </li>
              <li>You accept all risks associated with using experimental blockchain technology</li>
            </ul>
            <p>
              <strong>No Legal Advice:</strong> Nothing in this software or documentation
              constitutes legal, tax, or financial advice. You should consult qualified
              professionals regarding the legality and tax implications of using this software in
              your jurisdiction.
            </p>
          </section>

          <section className='legal-section'>
            <h2>7. User Conduct Restrictions</h2>
            <p>By using this software, you agree that you will NOT use it for any purpose that:</p>
            <ul>
              <li>
                Infringes upon or violates the rights of any other person or entity, including
                intellectual property rights, privacy rights, or contractual rights
              </li>
              <li>
                Violates any criminal law in any jurisdiction that applies to you, the recipient, or
                the transaction
              </li>
              <li>
                Facilitates, aids, or abets any criminal activity, including but not limited to
                fraud, theft, extortion, or trafficking
              </li>
              <li>Causes harm to others through deception, coercion, or exploitation</li>
            </ul>
            <p>
              You accept sole responsibility for ensuring that your use of this software complies
              with all applicable laws and does not infringe on the rights of others.
            </p>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.conductRestrictions}
                onChange={() => handleCheckboxChange('conductRestrictions')}
              />
              <span>
                I agree not to use this software for any purpose that infringes on others' rights or
                violates criminal law in any jurisdiction
              </span>
            </label>
          </section>

          <section className='legal-section'>
            <h2>8. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless all contributors and their
              affiliates from and against any and all claims, actions, proceedings, damages, losses,
              liabilities, costs, and expenses (including reasonable attorneys' fees and court
              costs) arising out of or related to:
            </p>
            <ul>
              <li>Your use or misuse of this software</li>
              <li>Your violation of these Terms of Use</li>
              <li>Your violation of any applicable law, regulation, or third-party rights</li>
              <li>Any transaction you conduct using this software</li>
              <li>Any claim that your use of this software caused damage to a third party</li>
              <li>
                Any regulatory investigation or enforcement action related to your use of this
                software
              </li>
            </ul>
            <p>
              This indemnification obligation will survive termination of this agreement and your
              use of the software.
            </p>
          </section>

          <section className='legal-section'>
            <h2>9. Dispute Resolution</h2>
            <p>
              This software is provided by independent open-source contributors. No contributor
              operates a service, company, or entity in connection with this software. By using this
              software, you acknowledge that:
            </p>
            <ul>
              <li>No contractual service relationship exists between you and any contributor</li>
              <li>
                Contributors provide source code only and make no ongoing commitments to users
              </li>
              <li>
                Any dispute arising from your use of this software is governed by the laws of your
                jurisdiction of residence
              </li>
              <li>
                You are solely responsible for determining the legal implications of using this
                software in your jurisdiction
              </li>
            </ul>
          </section>

          <section className='legal-section'>
            <h2>10. Governing Law</h2>
            <p>
              This agreement shall be governed by and construed in accordance with the laws of the
              jurisdiction in which you reside. No individual, company, or entity claims ownership
              of or responsibility for this software.
            </p>
          </section>

          <section className='legal-section'>
            <h2>11. License & Restrictions</h2>
            <p>
              This software is provided under a modified AGPL-3.0 license with the following
              additional restrictions that apply to all users and derivative works:
            </p>
            <ul>
              <li>
                All derivative works, forks, and distributions of this software must include the
                Private Proof of Innocence (PPOI) system and all sanctions compliance functionality,
                unmodified and fully operational, using the official PPOI aggregator at
                ppoi.fdi.network
              </li>
              <li>
                The sale, resale, or commercial distribution of this software or any derivative work
                is prohibited without explicit written permission from the copyright holders
              </li>
              <li>
                Any use or distribution that does not comply with these restrictions is a violation
                of this license and may constitute a violation of applicable law
              </li>
            </ul>
            <p>
              These restrictions are additional terms under Section 7 of the AGPL-3.0 and are
              binding on all recipients of the software. All other AGPL-3.0 terms apply, including
              the requirement to make source code available for derivative works.
            </p>
            <p>
              <strong>No Relationship</strong>
            </p>
            <p>
              Contributors provide only source code that users may choose to compile and run at
              their own discretion. No support, maintenance, updates, or security patches are
              guaranteed. No agency, partnership, joint venture, or employment relationship is
              intended or created by this agreement.
            </p>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.licenseRestrictions}
                onChange={() => handleCheckboxChange('licenseRestrictions')}
              />
              <span>
                I agree to the license restrictions, including that all derivative works must retain
                PPOI and sanctions compliance, and that commercial distribution requires written
                permission
              </span>
            </label>
          </section>

          <section className='legal-section'>
            <h2>12. Severability, Waiver & Entire Agreement</h2>
            <p>
              <strong>Severability</strong>
            </p>
            <p>
              If any provision of this agreement is held to be invalid, illegal, or unenforceable,
              the remaining provisions shall continue in full force and effect. The invalid
              provision shall be modified to the minimum extent necessary to make it valid and
              enforceable while preserving the original intent.
            </p>
            <p>
              <strong>No Waiver</strong>
            </p>
            <p>
              The failure to enforce any right or provision of this agreement shall not constitute a
              waiver of such right or provision.
            </p>
            <p>
              <strong>Entire Agreement</strong>
            </p>
            <p>
              This agreement constitutes the entire agreement regarding the use of this software and
              supersedes all prior agreements and understandings, whether written or oral.
            </p>
          </section>

          <section className='legal-section'>
            <h2>13. Acknowledgment</h2>
            <p>By checking the boxes below and clicking "I Accept," you acknowledge that:</p>
            <ul>
              <li>You have read and understand this entire agreement</li>
              <li>You voluntarily agree to be bound by all of its terms</li>
              <li>You have had the opportunity to seek legal counsel before accepting</li>
              <li>This agreement is a legally binding contract</li>
            </ul>
            <label className='legal-checkbox inline-checkbox'>
              <input
                type='checkbox'
                checked={checkboxes.noWarranty}
                onChange={() => handleCheckboxChange('noWarranty')}
              />
              <span>
                I accept full responsibility for my use of this software, agree to indemnify all
                contributors, and waive any right to seek damages from anyone
              </span>
            </label>
          </section>

          {!hasScrolledToBottom && (
            <div className='scroll-indicator'>Scroll to the bottom to continue</div>
          )}
        </div>

        <div className='legal-modal-footer'>
          <button className='btn-accept' onClick={onAccept} disabled={!canAccept}>
            {!hasScrolledToBottom
              ? 'Please read the entire agreement'
              : !allChecked
                  ? 'Please check all boxes to continue'
                  : 'I Accept This Binding Agreement'}
          </button>
        </div>
      </div>
    </div>
  )
}
