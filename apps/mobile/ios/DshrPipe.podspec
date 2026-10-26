# The phone's iroh pipe as a vendored dynamic framework (built by ../native/build.sh ios).
Pod::Spec.new do |s|
  s.name = 'DshrPipe'
  s.version = '0.1.0'
  s.summary = 'DSH Remote iroh transport (apps/mobile/native/dshr_pipe)'
  s.homepage = 'https://github.com/n0-computer/iroh'
  s.license = { :type => 'MIT OR Apache-2.0' }
  s.author = 'DSH Remote'
  s.source = { :path => '.' }
  s.platform = :ios, '17.5'
  s.vendored_frameworks = 'Frameworks/DshrPipe.xcframework'
end
